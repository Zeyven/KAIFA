import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '@lanxu/contracts';
import {
  DEFAULT_SCHEDULING_WEIGHTS,
  canTransitionTechnician,
  recommend,
  type HardConstraintFacts,
  type ScoreableCandidate,
  type TechnicianState,
} from '@lanxu/domain';
import { AuditService } from '../audit/audit.service';
import { appendStoreEvent } from '../common/store-events';
import type { AuditActor } from '../common/http-context';
import { PG_POOL, requirePool } from '../db/pg.module';

interface SchedContext {
  storeId: string;
  orgId: string;
  actor: AuditActor;
  actorEmployeeId?: string;
  permissionCodes?: string[] | null;
}

interface CandidateRow {
  entry_id: string;
  position_key: string;
  priority_delta: number;
  eligible_since: Date;
  tech_id: string;
  technician_no: string;
  status: string;
  queue_enabled: boolean;
  gender_code: string;
  employment_status: string;
  on_shift: boolean;
  has_skill: boolean;
  services_today: number;
}

/**
 * Scheduling (spec §6/§7.3): queue read, explainable recommend, atomic assign
 * (row locks + in-tx revalidation ⇒ exactly-one winner, §6.4), skip/compensate/
 * reorder queue ops. Weights echoed to clients and tagged as pilot defaults.
 */
@Injectable()
export class SchedulingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private db(): Pool {
    return requirePool(this.pool);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db().connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Shared candidate SQL: active entries + technician + shift + skill facts. */
  private async loadCandidates(
    client: PoolClient | Pool,
    storeId: string,
    serviceVariantId: string | null,
  ): Promise<CandidateRow[]> {
    const { rows } = await client.query<CandidateRow>(
      `SELECT e.id AS entry_id, e.position_key, e.priority_delta, e.eligible_since,
              t.id AS tech_id, t.technician_no, t.status, t.queue_enabled, t.gender_code,
              emp.employment_status,
              EXISTS (
                SELECT 1 FROM technician_shifts sh
                WHERE sh.technician_id = t.id AND sh.status = 'ACTIVE'
                  AND sh.starts_at <= now() AND sh.ends_at > now()
              ) AS on_shift,
              (
                $2::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM technician_skills sk
                  WHERE sk.technician_id = t.id AND sk.service_variant_id = $2
                    AND sk.enabled
                )
              ) AS has_skill,
              (
                SELECT count(*) FROM technician_status_history h
                WHERE h.technician_id = t.id AND h.to_status = 'SERVING'
                  AND h.occurred_at >= (
                    ((now() AT TIME ZONE s.timezone)::date
                     - CASE WHEN (now() AT TIME ZONE s.timezone)::time < s.business_date_cutoff_time
                            THEN 1 ELSE 0 END
                    ) + s.business_date_cutoff_time
                  ) AT TIME ZONE s.timezone
              )::int AS services_today
       FROM technician_queue_entries e
       JOIN technicians t ON t.id = e.technician_id
       JOIN employees emp ON emp.id = t.employee_id
       JOIN stores s ON s.id = e.store_id
       WHERE e.store_id = $1 AND e.state = 'ACTIVE'
       ORDER BY (e.position_key - e.priority_delta) ASC, e.eligible_since ASC, e.id ASC`,
      [storeId, serviceVariantId],
    );
    return rows;
  }

  private toScoreable(
    rows: CandidateRow[],
    requiredGender: string | null,
    now: Date,
  ): Array<ScoreableCandidate & { facts: HardConstraintFacts; entryId: string }> {
    return rows.map((r, i) => {
      const idleMinutes = Math.max(
        0,
        Math.floor((now.getTime() - new Date(r.eligible_since).getTime()) / 60_000),
      );
      return {
        entryId: r.entry_id,
        technicianId: r.tech_id,
        technicianNo: r.technician_no,
        queuePosition: i + 1,
        idleMinutes,
        servicesToday: r.services_today,
        compensationDelta: r.priority_delta,
        skillMatch: 1,
        preference: 0,
        reservationApproaching: 0, // reservation data lands with scheduling-reservations phase
        overtimeRisk: 0, // overtime policy data not yet available
        facts: {
          sameStore: true, // query is store-scoped
          employmentActive: r.employment_status === 'ACTIVE',
          onShift: r.on_shift,
          status: r.status,
          queueEnabled: r.queue_enabled,
          locked: r.status === 'LOCKED',
          hasActiveService: ['ASSIGNED', 'GOING_TO_ROOM', 'WAITING_START', 'SERVING'].includes(
            r.status,
          ),
          hasRequiredSkill: r.has_skill,
          genderMatches: requiredGender === null || r.gender_code === requiredGender,
          reservationConflict: false,
        },
      };
    });
  }

  async queue(storeId: string): Promise<{ data: unknown }> {
    const { rows } = await this.db().query(
      `SELECT e.id, e.technician_id, t.technician_no, e.queue_type, e.position_key,
              e.priority_delta, (e.position_key - e.priority_delta) AS effective_key,
              e.eligible_since, e.state, e.version, t.status AS technician_status
       FROM technician_queue_entries e
       JOIN technicians t ON t.id = e.technician_id
       WHERE e.store_id = $1 AND e.state = 'ACTIVE'
       ORDER BY (e.position_key - e.priority_delta) ASC, e.eligible_since ASC, e.id ASC`,
      [storeId],
    );
    return {
      data: {
        items: rows,
        nextCursor: null,
        weights: DEFAULT_SCHEDULING_WEIGHTS,
        policy: 'BUSINESS POLICY — REQUIRES PILOT VALIDATION',
      },
    };
  }

  async recommend(
    ctx: SchedContext,
    input: { serviceVariantId?: string; genderCode?: string },
  ): Promise<{ data: unknown }> {
    const candidates = await this.loadCandidates(
      this.db(),
      ctx.storeId,
      input.serviceVariantId ?? null,
    );
    const scoreable = this.toScoreable(candidates, input.genderCode ?? null, new Date());
    const result = recommend(scoreable, DEFAULT_SCHEDULING_WEIGHTS);
    return {
      data: {
        ...result,
        weights: DEFAULT_SCHEDULING_WEIGHTS,
        policy: 'BUSINESS POLICY — REQUIRES PILOT VALIDATION',
      },
    };
  }

  /** §6.4 atomic assignment: lock technician + entry, revalidate, persist. */
  async assign(
    ctx: SchedContext,
    input: { technicianId: string; serviceVariantId?: string; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const techRes = await client.query<{
        id: string;
        employee_id: string;
        status: string;
        queue_enabled: boolean;
        version: number;
      }>(
        `SELECT id, employee_id, status, queue_enabled, version
         FROM technicians WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [input.technicianId, ctx.storeId],
      );
      const tech = techRes.rows[0];
      if (!tech) throw new ApiError('NOT_FOUND', 'Technician not found.');
      if (input.expectedVersion !== undefined && input.expectedVersion !== tech.version) {
        throw new ApiError('VERSION_CONFLICT', 'Technician was modified concurrently.');
      }

      // lock the technician's ACTIVE queue entry (entry lookup by technician)
      const entryRes = await client.query<{ id: string; version: number; state: string }>(
        `SELECT id, version, state FROM technician_queue_entries
         WHERE technician_id = $1 AND state = 'ACTIVE'
         FOR UPDATE`,
        [tech.id],
      );
      const entry = entryRes.rows[0];
      if (!entry) {
        throw new ApiError(
          'TECHNICIAN_NOT_AVAILABLE',
          'No active queue entry — technician is not queued for assignment.',
        );
      }

      // in-tx hard-constraint revalidation (§6.2 subset available at assign time)
      const shiftRes = await client.query(
        `SELECT 1 FROM technician_shifts
         WHERE technician_id = $1 AND status = 'ACTIVE'
           AND starts_at <= now() AND ends_at > now() LIMIT 1`,
        [tech.id],
      );
      let skillOk = true;
      if (input.serviceVariantId) {
        const skillRes = await client.query(
          `SELECT 1 FROM technician_skills
           WHERE technician_id = $1 AND service_variant_id = $2 AND enabled`,
          [tech.id, input.serviceVariantId],
        );
        skillOk = skillRes.rows.length > 0;
      }
      const assignable =
        tech.status === 'AVAILABLE' && tech.queue_enabled && shiftRes.rows.length > 0 && skillOk;

      const result = canTransitionTechnician(tech.status as TechnicianState, 'ASSIGN', {
        assignable,
      });
      if (!result.ok) throw new ApiError(result.code, result.detail);

      const upd = await client.query<{ version: number }>(
        `UPDATE technicians SET status = $2, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version`,
        [tech.id, result.next],
      );
      await client.query(
        `UPDATE technician_queue_entries
         SET state = 'ASSIGNED', version = version + 1, updated_at = now()
         WHERE id = $1`,
        [entry.id],
      );
      await client.query(
        `INSERT INTO technician_status_history
           (technician_id, from_status, to_status, reason_code, actor_employee_id, metadata)
         VALUES ($1, $2, $3, 'ASSIGN', $4, $5::jsonb)`,
        [
          tech.id,
          tech.status,
          result.next,
          ctx.actorEmployeeId ?? null,
          JSON.stringify({ queueEntryId: entry.id, requestId: ctx.actor.requestId ?? null }),
        ],
      );
      await client.query(
        `INSERT INTO technician_queue_events (queue_entry_id, event_type, reason, actor_id)
         VALUES ($1, 'ASSIGNED', 'ASSIGN', $2)`,
        [entry.id, ctx.actorEmployeeId ?? null],
      );
      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'technician.assign',
        resourceType: 'technician',
        resourceId: tech.id,
        before: { status: tech.status },
        after: { status: result.next, queueEntryId: entry.id },
      });
      await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'technician.status_changed',
        aggregateType: 'technician',
        aggregateId: tech.id,
        payload: { from: tech.status, to: result.next, reason: 'ASSIGN' },
        version: upd.rows[0]!.version,
      });
      await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'technician.queue_changed',
        aggregateType: 'technician_queue_entry',
        aggregateId: entry.id,
        payload: { queueEntryId: entry.id, state: 'ASSIGNED', technicianId: tech.id },
      });

      return {
        data: {
          technicianId: tech.id,
          status: result.next,
          version: upd.rows[0]!.version,
          queueEntryId: entry.id,
        },
      };
    });
  }

  async skip(
    ctx: SchedContext,
    input: { queueEntryId: string; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const entry = await this.lockEntry(client, ctx.storeId, input.queueEntryId);
      this.checkEntryVersion(entry, input.expectedVersion);
      const nextPos = await client.query<{ next_pos: string }>(
        `SELECT COALESCE(MAX(position_key), 0) + 1000 AS next_pos
         FROM technician_queue_entries WHERE store_id = $1 AND state = 'ACTIVE'`,
        [ctx.storeId],
      );
      const upd = await client.query<{ version: number; position_key: string }>(
        `UPDATE technician_queue_entries
         SET position_key = $2, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version, position_key`,
        [entry.id, nextPos.rows[0]!.next_pos],
      );
      await client.query(
        `INSERT INTO technician_queue_events
           (queue_entry_id, event_type, old_position_key, new_position_key, reason, actor_id)
         VALUES ($1, 'SKIPPED', $2, $3, 'SKIP', $4)`,
        [entry.id, entry.position_key, upd.rows[0]!.position_key, ctx.actorEmployeeId ?? null],
      );
      await this.queueAudit(ctx, client, entry.id, 'schedule.skip', {
        from: entry.position_key,
        to: upd.rows[0]!.position_key,
      });
      await this.queueEvent(ctx, client, entry.id, 'SKIPPED');
      return {
        data: {
          queueEntryId: entry.id,
          positionKey: upd.rows[0]!.position_key,
          version: upd.rows[0]!.version,
        },
      };
    });
  }

  async compensate(
    ctx: SchedContext,
    input: { queueEntryId: string; delta: number; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const entry = await this.lockEntry(client, ctx.storeId, input.queueEntryId);
      this.checkEntryVersion(entry, input.expectedVersion);
      const upd = await client.query<{ version: number; priority_delta: number }>(
        `UPDATE technician_queue_entries
         SET priority_delta = priority_delta + $2, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version, priority_delta`,
        [entry.id, input.delta],
      );
      await client.query(
        `INSERT INTO technician_queue_events
           (queue_entry_id, event_type, reason, actor_id)
         VALUES ($1, 'COMPENSATED', $2, $3)`,
        [entry.id, `delta=${input.delta}`, ctx.actorEmployeeId ?? null],
      );
      await this.queueAudit(ctx, client, entry.id, 'schedule.compensate', {
        delta: input.delta,
        priorityDelta: upd.rows[0]!.priority_delta,
      });
      await this.queueEvent(ctx, client, entry.id, 'COMPENSATED');
      return {
        data: {
          queueEntryId: entry.id,
          priorityDelta: upd.rows[0]!.priority_delta,
          version: upd.rows[0]!.version,
        },
      };
    });
  }

  async reorder(
    ctx: SchedContext,
    input: {
      items: Array<{ entryId: string; positionKey: number; expectedVersion?: number }>;
    },
  ): Promise<{ data: unknown }> {
    if (input.items.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'items must not be empty.');
    }
    if (input.items.length > 50) {
      throw new ApiError('VALIDATION_FAILED', 'reorder limited to 50 entries per call.');
    }
    return this.tx(async (client) => {
      const ids = input.items.map((i) => i.entryId).sort();
      const lockRes = await client.query<{
        id: string;
        position_key: string;
        version: number;
        state: string;
      }>(
        `SELECT id, position_key, version, state FROM technician_queue_entries
         WHERE store_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [ctx.storeId, ids],
      );
      const byId = new Map(lockRes.rows.map((r) => [r.id, r]));
      const applied: Array<{ entryId: string; positionKey: number; version: number }> = [];
      for (const item of input.items) {
        const row = byId.get(item.entryId);
        if (!row) throw new ApiError('NOT_FOUND', 'Queue entry not found.');
        if (row.state !== 'ACTIVE') {
          throw new ApiError('INVALID_STATE_TRANSITION', `Entry not active: ${row.state}`);
        }
        if (item.expectedVersion !== undefined && item.expectedVersion !== row.version) {
          throw new ApiError('VERSION_CONFLICT', 'Queue entry was modified concurrently.');
        }
        const upd = await client.query<{ version: number }>(
          `UPDATE technician_queue_entries
           SET position_key = $2, version = version + 1, updated_at = now()
           WHERE id = $1 RETURNING version`,
          [row.id, item.positionKey],
        );
        await client.query(
          `INSERT INTO technician_queue_events
             (queue_entry_id, event_type, old_position_key, new_position_key, reason, actor_id)
           VALUES ($1, 'REORDERED', $2, $3, 'REORDER', $4)`,
          [row.id, row.position_key, item.positionKey, ctx.actorEmployeeId ?? null],
        );
        applied.push({
          entryId: row.id,
          positionKey: item.positionKey,
          version: upd.rows[0]!.version,
        });
      }
      await this.queueAudit(ctx, client, input.items[0]!.entryId, 'schedule.reorder', {
        count: applied.length,
      });
      await this.queueEvent(ctx, client, input.items[0]!.entryId, 'REORDERED');
      return { data: { items: applied } };
    });
  }

  private async lockEntry(
    client: PoolClient,
    storeId: string,
    entryId: string,
  ): Promise<{ id: string; position_key: string; version: number; state: string }> {
    const { rows } = await client.query<{
      id: string;
      position_key: string;
      version: number;
      state: string;
    }>(
      `SELECT id, position_key, version, state FROM technician_queue_entries
       WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [entryId, storeId],
    );
    if (!rows[0]) throw new ApiError('NOT_FOUND', 'Queue entry not found.');
    if (rows[0].state !== 'ACTIVE') {
      throw new ApiError('INVALID_STATE_TRANSITION', `Entry not active: ${rows[0].state}`);
    }
    return rows[0];
  }

  private checkEntryVersion(entry: { version: number }, expectedVersion?: number): void {
    if (expectedVersion !== undefined && expectedVersion !== entry.version) {
      throw new ApiError('VERSION_CONFLICT', 'Queue entry was modified concurrently.');
    }
  }

  private async queueAudit(
    ctx: SchedContext,
    client: PoolClient,
    entryId: string,
    action: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(client, {
      organizationId: ctx.orgId,
      storeId: ctx.storeId,
      actor: ctx.actor,
      action,
      resourceType: 'technician_queue_entry',
      resourceId: entryId,
      after,
    });
  }

  private async queueEvent(
    ctx: SchedContext,
    client: PoolClient,
    entryId: string,
    via: string,
  ): Promise<void> {
    await appendStoreEvent(client, {
      storeId: ctx.storeId,
      type: 'technician.queue_changed',
      aggregateType: 'technician_queue_entry',
      aggregateId: entryId,
      payload: { queueEntryId: entryId, via },
    });
  }
}
