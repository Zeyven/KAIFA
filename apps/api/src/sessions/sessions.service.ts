import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '@lanxu/contracts';
import {
  assertSessionTransition,
  canTransitionTechnician,
  canTransition as canTransitionRoom,
  completeServiceTarget,
  type ServiceSessionState,
  type TechnicianState,
} from '@lanxu/domain';
import { AuditService } from '../audit/audit.service';
import { appendStoreEvent } from '../common/store-events';
import { OrdersService } from '../orders/orders.service';
import type { AuditActor } from '../common/http-context';
import { PG_POOL, requirePool } from '../db/pg.module';

export interface SessionCommandContext {
  storeId: string;
  orgId: string;
  actor: AuditActor;
  actorEmployeeId?: string;
  permissionCodes?: string[] | null;
}

export interface SessionRow {
  id: string;
  store_id: string;
  visit_id: string;
  room_id: string;
  service_variant_id: string;
  technician_id: string | null;
  /** Employee behind technician_id — the identity the self-service gate compares. */
  technician_employee_id: string | null;
  assignment_type: string;
  status: ServiceSessionState;
  duration_minutes: number;
  scheduled_end_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  price_cents: string;
  queue_position_snapshot: number | null;
  version: number;
}

interface TechRow {
  id: string;
  store_id: string;
  employee_id: string;
  status: TechnicianState;
  queue_enabled: boolean;
  version: number;
}

/** "Running" for the room guard = actually in progress (§5.1 no running session). */
const RUNNING_STATES = `('STARTED','ENDING_SOON')`;

/**
 * Visit/ServiceSession commands (spec §4.6, §5.3, §7.3). Every command:
 * tx → lock session (+technician/room in stable order) → session machine +
 * guards revalidated in-tx → mirrored technician progression → session events
 * → room machine sync (SERVICE_STARTED / ALL_SERVICES_COMPLETED) → audit →
 * outbox store events. Object-level: sessions load store-scoped (404 cross
 * store); lifecycle commands are identity-gated (own session as the linked
 * technician) or require service.manage — route perms alone never authorize
 * acting on someone else's session.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
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

  private async lockSession(
    client: PoolClient,
    storeId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const res = await client.query<SessionRow>(
      `SELECT s.id, s.store_id, s.visit_id, s.room_id, s.service_variant_id, s.technician_id,
              t.employee_id AS technician_employee_id,
              s.assignment_type, s.status, s.duration_minutes, s.scheduled_end_at, s.started_at,
              s.ended_at, s.price_cents, s.queue_position_snapshot, s.version
       FROM service_sessions s
       LEFT JOIN technicians t ON t.id = s.technician_id
       WHERE s.id = $1 AND s.store_id = $2 FOR UPDATE OF s`,
      [sessionId, storeId],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Service session not found.');
    return row;
  }

  private checkVersion(row: SessionRow, expectedVersion?: number): void {
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw new ApiError('VERSION_CONFLICT', 'Service session was modified concurrently.');
    }
  }

  /** Self (linked technician) or service.manage — dynamic object-level gate. */
  private assertSessionActor(ctx: SessionCommandContext, row: SessionRow): void {
    const manage = ctx.permissionCodes?.includes('service.manage') ?? false;
    const self =
      ctx.actorEmployeeId !== undefined &&
      row.technician_employee_id !== null &&
      row.technician_employee_id === ctx.actorEmployeeId;
    if (!manage && !self) {
      throw new ApiError(
        'FORBIDDEN',
        'service.manage is required to run this session command for another employee.',
      );
    }
  }

  private async visitActive(
    client: PoolClient,
    storeId: string,
    visitId: string,
  ): Promise<boolean> {
    const res = await client.query<{ status: string; room_id: string }>(
      `SELECT status, room_id FROM visits WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [visitId, storeId],
    );
    if (!res.rows[0]) throw new ApiError('NOT_FOUND', 'Visit not found.');
    return res.rows[0].status === 'ACTIVE';
  }

  private async variantOf(
    client: PoolClient,
    orgId: string,
    variantId: string,
  ): Promise<{ id: string; duration_minutes: number; base_price_cents: string }> {
    const res = await client.query<{
      id: string;
      duration_minutes: number;
      base_price_cents: string;
    }>(
      `SELECT v.id, v.duration_minutes, v.base_price_cents
       FROM service_variants v JOIN services s ON s.id = v.service_id
       WHERE v.id = $1 AND s.organization_id = $2`,
      [variantId, orgId],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Service variant not found.');
    return row;
  }

  private async lockTech(
    client: PoolClient,
    storeId: string,
    technicianId: string,
  ): Promise<TechRow> {
    const res = await client.query<TechRow>(
      `SELECT id, store_id, employee_id, status, queue_enabled, version
       FROM technicians WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [technicianId, storeId],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Technician not found.');
    return row;
  }

  private async hasSkill(
    client: PoolClient,
    technicianId: string,
    variantId: string,
  ): Promise<boolean> {
    const res = await client.query(
      `SELECT 1 FROM technician_skills
       WHERE technician_id = $1 AND service_variant_id = $2 AND enabled = true`,
      [technicianId, variantId],
    );
    return res.rows.length > 0;
  }

  /**
   * Attach technician to a session: skill + status gates, technician machine
   * AVAILABLE→ASSIGNED (queue-ASSIGNED passes through), queue entry flips to
   * ASSIGNED, history append. Throws 422 with machine-readable codes.
   */
  private async attachTechnician(
    client: PoolClient,
    ctx: SessionCommandContext,
    technicianId: string,
    variantId: string,
    reasonCode: string,
    metadata: Record<string, unknown>,
  ): Promise<{ status: TechnicianState; transitioned: boolean; version: number }> {
    const tech = await this.lockTech(client, ctx.storeId, technicianId);
    if (tech.status === 'LOCKED') {
      throw new ApiError('TECHNICIAN_LOCKED', 'Technician is locked.');
    }
    if (!(await this.hasSkill(client, technicianId, variantId))) {
      throw new ApiError(
        'TECHNICIAN_NOT_AVAILABLE',
        `Technician lacks the required skill for variant ${variantId}.`,
      );
    }
    if (tech.status === 'ASSIGNED') {
      // already queue-assigned (scheduling) — link only; partial unique index
      // below still protects against a second active session
      return { status: tech.status, transitioned: false, version: tech.version };
    }
    const result = canTransitionTechnician(tech.status, 'ASSIGN', { assignable: true });
    if (!result.ok) throw new ApiError(result.code, result.detail);

    const upd = await client.query<{ version: number }>(
      `UPDATE technicians SET status = $2, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING version`,
      [tech.id, result.next],
    );
    await client.query(
      `INSERT INTO technician_status_history
         (technician_id, from_status, to_status, reason_code, actor_employee_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        tech.id,
        tech.status,
        result.next,
        reasonCode,
        ctx.actorEmployeeId ?? null,
        JSON.stringify(metadata),
      ],
    );
    // queue entry (if ACTIVE) follows the technician into ASSIGNED
    const entry = await client.query<{ id: string }>(
      `UPDATE technician_queue_entries SET state = 'ASSIGNED', version = version + 1, updated_at = now()
       WHERE technician_id = $1 AND state = 'ACTIVE'
       RETURNING id`,
      [tech.id],
    );
    if (entry.rows[0]) {
      await client.query(
        `INSERT INTO technician_queue_events (queue_entry_id, event_type, reason, actor_id)
         VALUES ($1, 'ASSIGNED', $2, $3)`,
        [entry.rows[0].id, reasonCode, ctx.actorEmployeeId ?? null],
      );
    }
    return { status: result.next, transitioned: true, version: upd.rows[0]!.version };
  }

  /** Post-service / pre-start release: recompute (shift) + requeue + history. */
  private async releaseTechnician(
    client: PoolClient,
    ctx: SessionCommandContext,
    technicianId: string,
    reasonCode: string,
    metadata: Record<string, unknown>,
  ): Promise<{ status: TechnicianState; queueReactivated: boolean }> {
    const tech = await this.lockTech(client, ctx.storeId, technicianId);
    if (tech.status === 'AVAILABLE' || tech.status === 'OFF_DUTY') {
      return { status: tech.status, queueReactivated: false };
    }
    let target: TechnicianState;
    if (tech.status === 'SERVING') {
      const shift = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM technician_shifts
           WHERE technician_id = $1 AND status = 'ACTIVE'
             AND starts_at <= now() AND ends_at > now()
         ) AS active`,
        [tech.id],
      );
      target = completeServiceTarget(!shift.rows[0]!.active);
    } else {
      // pre-service states (ASSIGNED/GOING_TO_ROOM/WAITING_START) → RELEASE
      const r = canTransitionTechnician(tech.status, 'RELEASE', { onShift: true });
      if (!r.ok) throw new ApiError(r.code, r.detail);
      target = r.next;
    }
    if (target === tech.status) return { status: tech.status, queueReactivated: false };

    await client.query(
      `UPDATE technicians SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [tech.id, target],
    );
    await client.query(
      `INSERT INTO technician_status_history
         (technician_id, from_status, to_status, reason_code, actor_employee_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        tech.id,
        tech.status,
        target,
        reasonCode,
        ctx.actorEmployeeId ?? null,
        JSON.stringify(metadata),
      ],
    );
    let queueReactivated = false;
    if (target === 'AVAILABLE' && tech.queue_enabled) {
      const entry = await client.query<{ id: string }>(
        `UPDATE technician_queue_entries SET state = 'ACTIVE', version = version + 1,
                eligible_since = CASE WHEN eligible_since > now() - interval '5 minutes' THEN eligible_since ELSE now() END,
                updated_at = now()
         WHERE technician_id = $1 AND state = 'ASSIGNED'
         RETURNING id`,
        [tech.id],
      );
      if (entry.rows[0]) {
        queueReactivated = true;
        await client.query(
          `INSERT INTO technician_queue_events (queue_entry_id, event_type, reason, actor_id)
           VALUES ($1, 'REQUEUED', $2, $3)`,
          [entry.rows[0].id, reasonCode, ctx.actorEmployeeId ?? null],
        );
      }
      await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'technician.queue_changed',
        aggregateType: 'technician_queue_entry',
        aggregateId: tech.id,
        payload: { technicianId: tech.id, via: reasonCode },
      });
    }
    return { status: target, queueReactivated };
  }

  private async sessionEvent(
    client: PoolClient,
    sessionId: string,
    eventType: string,
    ctx: SessionCommandContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO service_session_events (service_session_id, event_type, actor_type, actor_id, payload)
       VALUES ($1, $2, 'STAFF', $3, $4::jsonb)`,
      [sessionId, eventType, ctx.actorEmployeeId ?? null, JSON.stringify(payload)],
    );
  }

  private async bumpSession(
    client: PoolClient,
    row: SessionRow,
    next: ServiceSessionState,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const cols: string[] = ['status = $2', 'version = version + 1', 'updated_at = now()'];
    const params: unknown[] = [row.id, next];
    let i = 3;
    for (const [k, v] of Object.entries(extra)) {
      cols.push(`${k} = $${i}`);
      params.push(v);
      i += 1;
    }
    const res = await client.query<{ version: number }>(
      `UPDATE service_sessions SET ${cols.join(', ')} WHERE id = $1 RETURNING version`,
      params,
    );
    return res.rows[0]!.version;
  }

  /** Room sync: soft-skip when the room already moved past the trigger. */
  private async syncRoom(
    client: PoolClient,
    storeId: string,
    roomId: string,
    command: 'SERVICE_STARTED' | 'ALL_SERVICES_COMPLETED',
    guards: { hasActiveSession?: boolean; hasRunningSession?: boolean },
  ): Promise<string | null> {
    const res = await client.query<{
      operational_state: string;
      version: number;
    }>(
      `SELECT operational_state, version FROM rooms
       WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [roomId, storeId],
    );
    const room = res.rows[0];
    if (!room) throw new ApiError('NOT_FOUND', 'Room for session not found.');
    const applied = canTransitionRoom(
      room.operational_state as Parameters<typeof canTransitionRoom>[0],
      command,
      guards,
    );
    if (!applied.ok) {
      const structural =
        applied.code === 'INVALID_STATE_TRANSITION' &&
        (command === 'SERVICE_STARTED' || room.operational_state === 'OCCUPIED_WAITING_SERVICE');
      if (structural) throw new ApiError(applied.code, applied.detail);
      return null; // soft skip (e.g. complete after visit moved away → DIRTY)
    }
    await client.query(
      `UPDATE rooms SET operational_state = $2, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [roomId, applied.next],
    );
    await appendStoreEvent(client, {
      storeId,
      type: 'room.updated',
      aggregateType: 'room',
      aggregateId: roomId,
      payload: { roomId, operationalState: applied.next, via: command },
    });
    return applied.next;
  }

  /**
   * GET /v1/service-sessions — additive store-scoped read (spec §7.3 lists
   * per-id GET only; the FrontDesk board needs store aggregates). `today`
   * aligns to the VISIT business_date (same cutoff math as visit open).
   */
  async list(
    storeId: string,
    q: {
      technicianId?: string;
      roomId?: string;
      status?: string;
      activeOnly?: boolean;
      today?: boolean;
      limit?: number;
    },
  ): Promise<{ data: unknown }> {
    const conds: string[] = ['s.store_id = $1'];
    const params: unknown[] = [storeId];
    let i = 2;
    if (q.technicianId) {
      conds.push(`s.technician_id = $${i}`);
      params.push(q.technicianId);
      i += 1;
    }
    if (q.roomId) {
      conds.push(`s.room_id = $${i}`);
      params.push(q.roomId);
      i += 1;
    }
    if (q.status) {
      conds.push(`s.status = $${i}`);
      params.push(q.status);
      i += 1;
    }
    if (q.activeOnly) {
      // not-terminal states (mirrors isActiveSessionState in domain)
      conds.push(
        `s.status IN ('DRAFT','ASSIGNED','ACKNOWLEDGED','ARRIVED','STARTED','ENDING_SOON')`,
      );
    }
    if (q.today) {
      conds.push(
        `v.business_date = ((now() AT TIME ZONE st.timezone)::date
           - CASE WHEN (now() AT TIME ZONE st.timezone)::time < st.business_date_cutoff_time
                  THEN 1 ELSE 0 END)`,
      );
    }
    params.push(Math.min(Math.max(q.limit ?? 100, 1), 500));
    const { rows } = await this.db().query<SessionRow & { created_at: string }>(
      `SELECT s.id, s.store_id, s.visit_id, s.room_id, s.service_variant_id, s.technician_id,
              t.employee_id AS technician_employee_id,
              s.assignment_type, s.status, s.duration_minutes, s.scheduled_end_at, s.started_at,
              s.ended_at, s.price_cents, s.queue_position_snapshot, s.version, s.created_at
       FROM service_sessions s
       JOIN visits v ON v.id = s.visit_id
       JOIN stores st ON st.id = s.store_id
       LEFT JOIN technicians t ON t.id = s.technician_id
       WHERE ${conds.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT $${i}`,
      params,
    );
    return { data: { items: rows, nextCursor: null } };
  }

  // ───────────────────────────── commands ─────────────────────────────

  /**
   * POST /v1/service-sessions — create DRAFT (or directly ASSIGNED when a
   * technician is supplied, running the ASSIGN machine in the same tx).
   */
  create(
    ctx: SessionCommandContext,
    orgId: string,
    input: {
      visitId?: string;
      roomId?: string;
      serviceVariantId: string;
      technicianId?: string;
      assignmentType?: string;
      bedId?: string;
      expectedVersion?: number;
    },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      let visitId = input.visitId;
      let roomId = input.roomId;
      if (visitId) {
        const active = await this.visitActive(client, ctx.storeId, visitId);
        if (!active) throw new ApiError('INVALID_STATE_TRANSITION', 'Visit is not ACTIVE.');
        const visitRoom = await client.query<{ room_id: string }>(
          `SELECT room_id FROM visits WHERE id = $1`,
          [visitId],
        );
        roomId = visitRoom.rows[0]!.room_id;
        if (input.roomId && input.roomId !== roomId) {
          throw new ApiError('VALIDATION_FAILED', 'roomId does not match the visit room.');
        }
      } else if (roomId) {
        const room = await client.query<{ current_visit_id: string | null }>(
          `SELECT current_visit_id FROM rooms WHERE id = $1 AND store_id = $2`,
          [roomId, ctx.storeId],
        );
        if (!room.rows[0]) throw new ApiError('NOT_FOUND', 'Room not found.');
        if (!room.rows[0].current_visit_id) {
          throw new ApiError('ROOM_NOT_ELIGIBLE', 'Room has no active visit.');
        }
        visitId = room.rows[0].current_visit_id;
        const active = await this.visitActive(client, ctx.storeId, visitId);
        if (!active) throw new ApiError('INVALID_STATE_TRANSITION', 'Visit is not ACTIVE.');
      } else {
        throw new ApiError('VALIDATION_FAILED', 'visitId or roomId is required.');
      }

      // billing safety: every session-bearing visit always has a live order
      await this.orders.hookEnsureOrderOnSessionCreate(client, {
        storeId: ctx.storeId,
        visitId: visitId!,
      });

      const variant = await this.variantOf(client, orgId, input.serviceVariantId);
      let status: ServiceSessionState = 'DRAFT';
      let techState: TechnicianState | null = null;
      if (input.technicianId) {
        const attached = await this.attachTechnician(
          client,
          ctx,
          input.technicianId,
          input.serviceVariantId,
          'SESSION_CREATE',
          { visitId },
        );
        techState = attached.status;
        status = assertSessionTransition('DRAFT', 'ASSIGN');
      }

      const snapshot = await client.query<{ position: string | null }>(
        `SELECT position_key::text AS position FROM technician_queue_entries
         WHERE technician_id = $1 AND state IN ('ACTIVE','ASSIGNED')
         ORDER BY (position_key - priority_delta) LIMIT 1`,
        [input.technicianId ?? null],
      );
      const insert = await client.query<{ id: string; version: number }>(
        `INSERT INTO service_sessions
           (store_id, visit_id, room_id, bed_id, service_variant_id, technician_id,
            assignment_type, status, duration_minutes, price_cents,
            queue_position_snapshot, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, version`,
        [
          ctx.storeId,
          visitId,
          roomId,
          input.bedId ?? null,
          input.serviceVariantId,
          input.technicianId ?? null,
          input.assignmentType ?? 'ROTATION',
          status,
          variant.duration_minutes,
          variant.base_price_cents,
          snapshot.rows[0]?.position ?? null,
          ctx.actorEmployeeId ?? null,
        ],
      );
      const sessionId = insert.rows[0]!.id;
      await this.sessionEvent(client, sessionId, input.technicianId ? 'ASSIGNED' : 'CREATED', ctx, {
        visitId,
        roomId,
        serviceVariantId: input.serviceVariantId,
        technicianId: input.technicianId ?? null,
        status,
      });

      let storeSeq: number | null = null;
      if (input.technicianId) {
        const ev = await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: 'service.assigned',
          aggregateType: 'service_session',
          aggregateId: sessionId,
          version: 1,
          payload: {
            sessionId,
            visitId,
            roomId,
            technicianId: input.technicianId,
            technicianState: techState,
            assignmentType: input.assignmentType ?? 'ROTATION',
          },
        });
        storeSeq = ev.storeSeq;
        await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: 'technician.status_changed',
          aggregateType: 'technician',
          aggregateId: input.technicianId,
          payload: { technicianId: input.technicianId, via: 'SESSION_CREATE', sessionId },
        });
      }

      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'service.create',
        resourceType: 'service_session',
        resourceId: sessionId,
        before: null,
        after: {
          status,
          technicianId: input.technicianId ?? null,
          serviceVariantId: input.serviceVariantId,
        },
      });

      return {
        data: {
          sessionId,
          visitId,
          roomId,
          status,
          technicianId: input.technicianId ?? null,
          durationMinutes: variant.duration_minutes,
          priceCents: Number(variant.base_price_cents),
          version: insert.rows[0]!.version,
          storeSeq,
        },
      };
    });
  }

  /** GET /v1/service-sessions/{id} */
  async get(storeId: string, sessionId: string): Promise<{ data: unknown }> {
    const res = await this.db().query<SessionRow>(
      `SELECT id, store_id, visit_id, room_id, service_variant_id, technician_id,
              assignment_type, status, duration_minutes, scheduled_end_at, started_at,
              ended_at, price_cents, queue_position_snapshot, version
       FROM service_sessions WHERE id = $1 AND store_id = $2`,
      [sessionId, storeId],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Service session not found.');
    return { data: row };
  }

  /** POST /v1/service-sessions/{id}/assign — DRAFT → ASSIGNED with technician. */
  assign(
    ctx: SessionCommandContext,
    sessionId: string,
    input: { technicianId: string; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const row = await this.lockSession(client, ctx.storeId, sessionId);
      this.checkVersion(row, input.expectedVersion);
      if (!(await this.visitActive(client, ctx.storeId, row.visit_id))) {
        throw new ApiError('INVALID_STATE_TRANSITION', 'Visit is not ACTIVE.');
      }
      const next = assertSessionTransition(row.status, 'ASSIGN');
      const attached = await this.attachTechnician(
        client,
        ctx,
        input.technicianId,
        row.service_variant_id,
        'SESSION_ASSIGN',
        { sessionId },
      );
      try {
        const version = await this.bumpSession(client, row, next, {
          technician_id: input.technicianId,
          queue_position_snapshot:
            (
              await client.query<{ position: string | null }>(
                `SELECT position_key::text AS position FROM technician_queue_entries
                 WHERE technician_id = $1 AND state IN ('ACTIVE','ASSIGNED')
                 ORDER BY (position_key - priority_delta) LIMIT 1`,
                [input.technicianId],
              )
            ).rows[0]?.position ?? null,
        });
        await this.sessionEvent(client, sessionId, 'ASSIGNED', ctx, {
          technicianId: input.technicianId,
          status: next,
        });
        const ev = await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: 'service.assigned',
          aggregateType: 'service_session',
          aggregateId: sessionId,
          version: row.version + 1,
          payload: {
            sessionId,
            visitId: row.visit_id,
            roomId: row.room_id,
            technicianId: input.technicianId,
            technicianState: attached.status,
            assignmentType: row.assignment_type,
          },
        });
        if (attached.transitioned) {
          await appendStoreEvent(client, {
            storeId: ctx.storeId,
            type: 'technician.status_changed',
            aggregateType: 'technician',
            aggregateId: input.technicianId,
            payload: { technicianId: input.technicianId, via: 'SESSION_ASSIGN', sessionId },
          });
        }
        await this.audit.record(client, {
          organizationId: ctx.orgId,
          storeId: ctx.storeId,
          actor: ctx.actor,
          action: 'service.assign',
          resourceType: 'service_session',
          resourceId: sessionId,
          before: { technicianId: row.technician_id, status: row.status },
          after: { technicianId: input.technicianId, status: next },
        });
        return {
          data: {
            sessionId,
            status: next,
            technicianId: input.technicianId,
            version,
            storeSeq: ev.storeSeq,
          },
        };
      } catch (err) {
        // partial unique (one active session per technician) → 422 domain code
        if ((err as { code?: string }).code === '23505') {
          throw new ApiError(
            'TECHNICIAN_NOT_AVAILABLE',
            'Technician already has an active service session.',
          );
        }
        throw err;
      }
    });
  }

  private runLifecycle(
    ctx: SessionCommandContext,
    sessionId: string,
    command: 'ACKNOWLEDGE' | 'ARRIVE' | 'START' | 'COMPLETE' | 'TERMINATE' | 'CANCEL',
    input: { expectedVersion?: number; reasonCode?: string },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const row = await this.lockSession(client, ctx.storeId, sessionId);
      this.checkVersion(row, input.expectedVersion);
      this.assertSessionActor(ctx, row);
      const visitOpen =
        row.status === 'STARTED' || row.status === 'ENDING_SOON'
          ? true
          : await this.visitActive(client, ctx.storeId, row.visit_id);
      if (!visitOpen) throw new ApiError('INVALID_STATE_TRANSITION', 'Visit is not ACTIVE.');
      if (
        (command === 'ACKNOWLEDGE' || command === 'ARRIVE' || command === 'START') &&
        !row.technician_id
      ) {
        throw new ApiError('INVALID_STATE_TRANSITION', `Session has no technician for ${command}.`);
      }
      const next = assertSessionTransition(row.status, command);

      const payload: Record<string, unknown> = {
        sessionId,
        visitId: row.visit_id,
        roomId: row.room_id,
        technicianId: row.technician_id,
        status: next,
      };
      const extra: Record<string, unknown> = {};
      const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];

      if (command === 'ACKNOWLEDGE' || command === 'ARRIVE' || command === 'START') {
        const techCmd =
          command === 'ACKNOWLEDGE' ? 'ACK' : command === 'ARRIVE' ? 'ARRIVE' : 'START_SERVICE';
        const tech = await this.lockTech(client, ctx.storeId, row.technician_id!);
        const tr = canTransitionTechnician(tech.status, techCmd, { sessionActive: true });
        if (!tr.ok) throw new ApiError(tr.code, tr.detail);
        await client.query(
          `UPDATE technicians SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [tech.id, tr.next],
        );
        await client.query(
          `INSERT INTO technician_status_history
             (technician_id, from_status, to_status, reason_code, actor_employee_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            tech.id,
            tech.status,
            tr.next,
            techCmd,
            ctx.actorEmployeeId ?? null,
            JSON.stringify({ sessionId }),
          ],
        );
        outbox.push({
          type: 'technician.status_changed',
          payload: { technicianId: tech.id, via: techCmd, sessionId },
        });
      }

      if (command === 'CANCEL' && row.technician_id) {
        // booking cancelled while ASSIGNED → hand the technician back (§5.3)
        const released = await this.releaseTechnician(
          client,
          ctx,
          row.technician_id,
          'SESSION_CANCELLED',
          { sessionId },
        );
        payload.technicianState = released.status;
        outbox.push({
          type: 'technician.status_changed',
          payload: { technicianId: row.technician_id, via: command, sessionId },
        });
      }

      if (command === 'START') {
        const now = new Date();
        const end = new Date(now.getTime() + row.duration_minutes * 60_000);
        extra.started_at = now.toISOString();
        extra.scheduled_end_at = end.toISOString();
        const roomNext = await this.syncRoom(client, ctx.storeId, row.room_id, 'SERVICE_STARTED', {
          hasActiveSession: true,
        });
        payload.roomState = roomNext;
        outbox.push({ type: 'service.started', payload: { ...payload } });
        await this.orders.hookMarkInService(client, ctx.storeId, row.visit_id);
      }

      if (command === 'COMPLETE' || command === 'TERMINATE') {
        extra.ended_at = new Date().toISOString();
        if (row.technician_id) {
          const released = await this.releaseTechnician(
            client,
            ctx,
            row.technician_id,
            command === 'COMPLETE' ? 'SESSION_COMPLETE' : 'SESSION_TERMINATED',
            { sessionId },
          );
          payload.technicianState = released.status;
          outbox.push({
            type: 'technician.status_changed',
            payload: { technicianId: row.technician_id, via: command, sessionId },
          });
        }
        // room: no running sessions left → WAITING_CHECKOUT
        const running = await client.query(
          `SELECT 1 FROM service_sessions
           WHERE room_id = $1 AND id <> $2 AND status IN ${RUNNING_STATES}
           LIMIT 1`,
          [row.room_id, row.id],
        );
        if (running.rows.length === 0) {
          const roomNext = await this.syncRoom(
            client,
            ctx.storeId,
            row.room_id,
            'ALL_SERVICES_COMPLETED',
            { hasRunningSession: false },
          );
          payload.roomState = roomNext;
        }
        if (command === 'COMPLETE') {
          outbox.push({ type: 'service.completed', payload: { ...payload } });
          // billable snapshot: line item + totals + order.updated in this tx
          await this.orders.hookAttachServiceItem(client, {
            storeId: ctx.storeId,
            visitId: row.visit_id,
            sessionId,
            session: {
              price_cents: row.price_cents,
              service_variant_id: row.service_variant_id,
            },
          });
        }
      }

      if (command === 'CANCEL') outbox.push({ type: 'service.cancelled', payload: { ...payload } });

      const version = await this.bumpSession(client, row, next, extra);
      await this.sessionEvent(client, sessionId, command, ctx, payload);
      for (const o of outbox) {
        await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: o.type,
          aggregateType: o.type.startsWith('technician.') ? 'technician' : 'service_session',
          aggregateId: o.type.startsWith('technician.') ? row.technician_id! : sessionId,
          version: o.type.startsWith('technician.') ? 1 : row.version + 1,
          payload: o.payload,
        });
      }
      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: `service.${command.toLowerCase()}`,
        resourceType: 'service_session',
        resourceId: sessionId,
        before: { status: row.status },
        after: { status: next, reasonCode: input.reasonCode ?? null, ...payload },
      });

      return {
        data: {
          ...payload,
          sessionId,
          status: next,
          version,
          technicianId: row.technician_id,
          storeSeq: null,
        },
      };
    });
  }

  acknowledge(ctx: SessionCommandContext, sessionId: string, input: { expectedVersion?: number }) {
    return this.runLifecycle(ctx, sessionId, 'ACKNOWLEDGE', input);
  }

  cancel(
    ctx: SessionCommandContext,
    sessionId: string,
    input: { expectedVersion?: number; reasonCode?: string },
  ) {
    return this.runLifecycle(ctx, sessionId, 'CANCEL', input);
  }

  arrive(ctx: SessionCommandContext, sessionId: string, input: { expectedVersion?: number }) {
    return this.runLifecycle(ctx, sessionId, 'ARRIVE', input);
  }

  start(ctx: SessionCommandContext, sessionId: string, input: { expectedVersion?: number }) {
    return this.runLifecycle(ctx, sessionId, 'START', input);
  }

  complete(ctx: SessionCommandContext, sessionId: string, input: { expectedVersion?: number }) {
    return this.runLifecycle(ctx, sessionId, 'COMPLETE', input);
  }

  terminate(
    ctx: SessionCommandContext,
    sessionId: string,
    input: { reasonCode: string; expectedVersion?: number },
  ) {
    return this.runLifecycle(ctx, sessionId, 'TERMINATE', input);
  }

  /** POST /v1/service-sessions/{id}/extend — append extension + grow duration. */
  extend(
    ctx: SessionCommandContext,
    sessionId: string,
    input: { minutes: number; priceDeltaCents?: number; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const row = await this.lockSession(client, ctx.storeId, sessionId);
      this.checkVersion(row, input.expectedVersion);
      const next = assertSessionTransition(row.status, 'EXTEND');
      await client.query(
        `INSERT INTO service_extensions
           (service_session_id, minutes, price_delta_cents, approved_by, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          row.id,
          input.minutes,
          input.priceDeltaCents ?? 0,
          ctx.actorEmployeeId ?? null,
          ctx.actorEmployeeId ?? null,
        ],
      );
      const res = await client.query<{ version: number; scheduled_end_at: string | null }>(
        `UPDATE service_sessions
         SET duration_minutes = duration_minutes + $2,
             price_cents = price_cents + $3,
             scheduled_end_at = COALESCE(scheduled_end_at + ($2 || ' minutes')::interval, scheduled_end_at),
             status = $4, version = version + 1, updated_at = now()
         WHERE id = $1
         RETURNING version, scheduled_end_at`,
        [row.id, input.minutes, input.priceDeltaCents ?? 0, next],
      );
      const payload = {
        sessionId: row.id,
        minutes: input.minutes,
        priceDeltaCents: input.priceDeltaCents ?? 0,
        durationMinutes: row.duration_minutes + input.minutes,
        scheduledEndAt: res.rows[0]!.scheduled_end_at,
      };
      await this.sessionEvent(client, row.id, 'EXTENDED', ctx, payload);
      const ev = await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'service.extended',
        aggregateType: 'service_session',
        aggregateId: row.id,
        version: row.version + 1,
        payload,
      });
      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'service.extend',
        resourceType: 'service_session',
        resourceId: row.id,
        before: { durationMinutes: row.duration_minutes, priceCents: Number(row.price_cents) },
        after: { durationMinutes: row.duration_minutes + input.minutes, minutes: input.minutes },
      });
      return {
        data: {
          sessionId: row.id,
          status: next,
          durationMinutes: row.duration_minutes + input.minutes,
          version: res.rows[0]!.version,
          storeSeq: ev.storeSeq,
        },
      };
    });
  }

  /** POST /v1/service-sessions/{id}/change-technician — swap + record workflow. */
  changeTechnician(
    ctx: SessionCommandContext,
    sessionId: string,
    input: { technicianId: string; reasonCode: string; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const row = await this.lockSession(client, ctx.storeId, sessionId);
      this.checkVersion(row, input.expectedVersion);
      const next = assertSessionTransition(row.status, 'CHANGE_TECHNICIAN');
      const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
      if (row.technician_id === input.technicianId) {
        throw new ApiError('VALIDATION_FAILED', 'Technician is already assigned to this session.');
      }
      if (!(await this.visitActive(client, ctx.storeId, row.visit_id))) {
        throw new ApiError('INVALID_STATE_TRANSITION', 'Visit is not ACTIVE.');
      }

      // release the previous technician (pre-start states → RELEASE; serving → recompute)
      if (row.technician_id) {
        const oldTech = await this.lockTech(client, ctx.storeId, row.technician_id);
        if (oldTech.status === 'SERVING') {
          await this.releaseTechnician(
            client,
            ctx,
            row.technician_id,
            'SESSION_CHANGE_TECHNICIAN',
            { sessionId },
          );
          outbox.push({
            type: 'technician.status_changed',
            payload: { technicianId: row.technician_id, via: 'CHANGE_TECHNICIAN', sessionId },
          });
        } else {
          const r = canTransitionTechnician(oldTech.status, 'RELEASE', { onShift: true });
          if (r.ok) {
            await client.query(
              `UPDATE technicians SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
              [oldTech.id, r.next],
            );
            await client.query(
              `INSERT INTO technician_status_history
                 (technician_id, from_status, to_status, reason_code, actor_employee_id, metadata)
               VALUES ($1, $2, $3, 'RELEASE', $4, $5::jsonb)`,
              [
                oldTech.id,
                oldTech.status,
                r.next,
                ctx.actorEmployeeId ?? null,
                JSON.stringify({ sessionId }),
              ],
            );
            if (r.next === 'AVAILABLE' && oldTech.queue_enabled) {
              const e = await client.query<{ id: string }>(
                `UPDATE technician_queue_entries SET state = 'ACTIVE', version = version + 1, updated_at = now()
                 WHERE technician_id = $1 AND state = 'ASSIGNED' RETURNING id`,
                [oldTech.id],
              );
              if (e.rows[0]) {
                await client.query(
                  `INSERT INTO technician_queue_events (queue_entry_id, event_type, reason, actor_id)
                   VALUES ($1, 'REQUEUED', 'CHANGE_TECHNICIAN', $2)`,
                  [e.rows[0].id, ctx.actorEmployeeId ?? null],
                );
              }
            }
            outbox.push({
              type: 'technician.status_changed',
              payload: { technicianId: oldTech.id, via: 'CHANGE_TECHNICIAN', sessionId },
            });
          }
        }
      }

      const attached = await this.attachTechnician(
        client,
        ctx,
        input.technicianId,
        row.service_variant_id,
        'SESSION_CHANGE_TECHNICIAN',
        { sessionId, from: row.technician_id, reasonCode: input.reasonCode },
      );
      const version = await this.bumpSession(client, row, next, {
        technician_id: input.technicianId,
      });
      for (const o of outbox) {
        await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: o.type,
          aggregateType: 'technician',
          aggregateId: o.payload.technicianId as string,
          payload: o.payload,
        });
      }
      await client.query(
        `INSERT INTO technician_change_requests
           (store_id, session_id, from_technician_id, requested_technician_id,
            reason_code, status, requested_by, approved_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6, $6, now())`,
        [
          ctx.storeId,
          row.id,
          row.technician_id,
          input.technicianId,
          input.reasonCode,
          ctx.actorEmployeeId ?? null,
        ],
      );
      const payload = {
        sessionId: row.id,
        visitId: row.visit_id,
        roomId: row.room_id,
        technicianId: input.technicianId,
        fromTechnicianId: row.technician_id,
        technicianState: attached.status,
        reasonCode: input.reasonCode,
      };
      await this.sessionEvent(client, row.id, 'CHANGED_TECHNICIAN', ctx, payload);
      const ev = await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'service.assigned',
        aggregateType: 'service_session',
        aggregateId: row.id,
        version: row.version + 1,
        payload,
      });
      if (attached.transitioned) {
        await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: 'technician.status_changed',
          aggregateType: 'technician',
          aggregateId: input.technicianId,
          payload: {
            technicianId: input.technicianId,
            via: 'CHANGE_TECHNICIAN',
            sessionId: row.id,
          },
        });
      }
      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'service.change_technician',
        resourceType: 'service_session',
        resourceId: row.id,
        before: { technicianId: row.technician_id },
        after: { technicianId: input.technicianId, reasonCode: input.reasonCode },
      });
      return {
        data: {
          sessionId: row.id,
          status: next,
          technicianId: input.technicianId,
          version,
          storeSeq: ev.storeSeq,
        },
      };
    });
  }

  /** POST /v1/service-sessions/{id}/change-service — swap variant snapshot. */
  changeService(
    ctx: SessionCommandContext,
    sessionId: string,
    input: { serviceVariantId: string; expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const row = await this.lockSession(client, ctx.storeId, sessionId);
      this.checkVersion(row, input.expectedVersion);
      const next = assertSessionTransition(row.status, 'CHANGE_SERVICE');
      const variant = await this.variantOf(client, ctx.orgId, input.serviceVariantId);
      const version = await this.bumpSession(client, row, next, {
        service_variant_id: input.serviceVariantId,
        duration_minutes: variant.duration_minutes,
        price_cents: variant.base_price_cents,
        scheduled_end_at: row.started_at
          ? new Date(
              new Date(row.started_at).getTime() + variant.duration_minutes * 60_000,
            ).toISOString()
          : null,
      });
      const payload = {
        sessionId: row.id,
        fromVariantId: row.service_variant_id,
        serviceVariantId: input.serviceVariantId,
        durationMinutes: variant.duration_minutes,
        priceCents: Number(variant.base_price_cents),
      };
      await this.sessionEvent(client, row.id, 'CHANGED_SERVICE', ctx, payload);
      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'service.change_service',
        resourceType: 'service_session',
        resourceId: row.id,
        before: { serviceVariantId: row.service_variant_id, priceCents: Number(row.price_cents) },
        after: {
          serviceVariantId: input.serviceVariantId,
          priceCents: Number(variant.base_price_cents),
        },
      });
      return {
        data: { ...payload, sessionId: row.id, status: next, version, storeSeq: null },
      };
    });
  }
}
