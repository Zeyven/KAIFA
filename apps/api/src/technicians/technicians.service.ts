import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '@lanxu/contracts';
import {
  canTransitionTechnician,
  type TechnicianCommand,
  type TechnicianState,
} from '@lanxu/domain';
import { AuditService } from '../audit/audit.service';
import { appendStoreEvent } from '../common/store-events';
import type { AuditActor } from '../common/http-context';
import { PG_POOL, requirePool } from '../db/pg.module';

export interface TechnicianRow {
  id: string;
  store_id: string;
  employee_id: string;
  technician_no: string;
  level: string;
  gender_code: string;
  queue_enabled: boolean;
  status: TechnicianState;
  version: number;
}

export interface TechnicianCommandContext {
  storeId: string;
  orgId: string;
  actor: AuditActor;
  actorEmployeeId?: string;
  permissionCodes?: string[] | null;
}

/**
 * Technician commands (spec §5.2/§7.3). Every command: tx → lock → machine +
 * guards revalidated in-tx → status/history/queue writes → audit → outbox events.
 * Acting on ANOTHER employee's technician requires tech.manage (identity-gated
 * self-service otherwise) — dynamic object-level check, not just route perms.
 */
@Injectable()
export class TechniciansService {
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

  private async lock(
    client: PoolClient,
    storeId: string,
    technicianId: string,
  ): Promise<TechnicianRow> {
    const { rows } = await client.query<TechnicianRow>(
      `SELECT id, store_id, employee_id, technician_no, level, gender_code,
              queue_enabled, status, version
       FROM technicians WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [technicianId, storeId],
    );
    if (!rows[0]) throw new ApiError('NOT_FOUND', 'Technician not found.');
    return rows[0];
  }

  private assertActorCan(ctx: TechnicianCommandContext, target: TechnicianRow): void {
    if (ctx.actorEmployeeId && target.employee_id === ctx.actorEmployeeId) return;
    if (ctx.permissionCodes?.includes('tech.manage')) return;
    throw new ApiError(
      'FORBIDDEN',
      'tech.manage required to act on another employee’s technician.',
    );
  }

  private async activeShift(client: PoolClient, technicianId: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT 1 FROM technician_shifts
       WHERE technician_id = $1 AND status = 'ACTIVE'
         AND starts_at <= now() AND ends_at > now()
       LIMIT 1`,
      [technicianId],
    );
    return rows.length > 0;
  }

  private async recordTransition(
    client: PoolClient,
    ctx: TechnicianCommandContext,
    tech: TechnicianRow,
    next: TechnicianState,
    reason: string,
  ): Promise<number> {
    const { rows } = await client.query<{ version: number }>(
      `UPDATE technicians SET status = $2, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING version`,
      [tech.id, next],
    );
    await client.query(
      `INSERT INTO technician_status_history
         (technician_id, from_status, to_status, reason_code, actor_employee_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        tech.id,
        tech.status,
        next,
        reason,
        ctx.actorEmployeeId ?? null,
        JSON.stringify({ requestId: ctx.actor.requestId ?? null }),
      ],
    );
    await this.audit.record(client, {
      organizationId: ctx.orgId,
      storeId: ctx.storeId,
      actor: ctx.actor,
      action: `technician.${reason.toLowerCase()}`,
      resourceType: 'technician',
      resourceId: tech.id,
      before: { status: tech.status, version: tech.version },
      after: { status: next },
    });
    await appendStoreEvent(client, {
      storeId: ctx.storeId,
      type: 'technician.status_changed',
      aggregateType: 'technician',
      aggregateId: tech.id,
      payload: { from: tech.status, to: next, reason },
      version: rows[0]!.version,
    });
    return rows[0]!.version;
  }

  async list(storeId: string): Promise<{ data: unknown }> {
    const { rows } = await this.db().query(
      `SELECT t.id, t.technician_no, t.level, t.gender_code, t.queue_enabled,
              t.status, t.version, e.display_name, e.employee_no
       FROM technicians t JOIN employees e ON e.id = t.employee_id
       WHERE t.store_id = $1
       ORDER BY t.technician_no`,
      [storeId],
    );
    return { data: { items: rows, nextCursor: null } };
  }

  private async clock(
    ctx: TechnicianCommandContext,
    technicianId: string,
    command: 'CLOCK_IN' | 'CLOCK_OUT',
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const tech = await this.lock(client, ctx.storeId, technicianId);
      this.assertActorCan(ctx, tech);
      if (input.expectedVersion !== undefined && input.expectedVersion !== tech.version) {
        throw new ApiError('VERSION_CONFLICT', 'Technician was modified concurrently.');
      }

      const onShift = command === 'CLOCK_IN' ? await this.activeShift(client, tech.id) : true;
      const result = canTransitionTechnician(tech.status, command, { onShift });
      if (!result.ok) throw new ApiError(result.code, result.detail);

      const version = await this.recordTransition(
        client,
        ctx,
        tech,
        result.next,
        command === 'CLOCK_IN' ? 'CLOCK_IN' : 'CLOCK_OUT',
      );

      // queue lifecycle: enqueue on clock-in (queue_enabled), remove on clock-out
      let queued = false;
      if (command === 'CLOCK_IN' && tech.queue_enabled) {
        const existing = await client.query(
          `SELECT 1 FROM technician_queue_entries
           WHERE technician_id = $1 AND state = 'ACTIVE'`,
          [tech.id],
        );
        if (existing.rows.length === 0) {
          const pos = await client.query<{ next_pos: string }>(
            `SELECT COALESCE(MAX(position_key), 0) + 1000 AS next_pos
             FROM technician_queue_entries WHERE store_id = $1`,
            [ctx.storeId],
          );
          const entry = await client.query<{ id: string; position_key: string }>(
            `INSERT INTO technician_queue_entries (store_id, technician_id, position_key)
             VALUES ($1, $2, $3) RETURNING id, position_key`,
            [ctx.storeId, tech.id, pos.rows[0]!.next_pos],
          );
          await client.query(
            `INSERT INTO technician_queue_events (queue_entry_id, event_type, new_position_key, reason, actor_id)
             VALUES ($1, 'ENQUEUED', $2, 'CLOCK_IN', $3)`,
            [entry.rows[0]!.id, entry.rows[0]!.position_key, ctx.actorEmployeeId ?? null],
          );
          queued = true;
        }
      }
      if (command === 'CLOCK_OUT') {
        const removed = await client.query<{ id: string; position_key: string }>(
          `UPDATE technician_queue_entries
           SET state = 'REMOVED', version = version + 1, updated_at = now()
           WHERE technician_id = $1 AND state = 'ACTIVE'
           RETURNING id, position_key`,
          [tech.id],
        );
        for (const entry of removed.rows) {
          await client.query(
            `INSERT INTO technician_queue_events (queue_entry_id, event_type, old_position_key, reason, actor_id)
             VALUES ($1, 'DEQUEUED', $2, 'CLOCK_OUT', $3)`,
            [entry.id, entry.position_key, ctx.actorEmployeeId ?? null],
          );
          queued = true;
        }
      }
      if (queued) {
        await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: 'technician.queue_changed',
          aggregateType: 'technician_queue_entry',
          aggregateId: technicianId,
          payload: { technicianId, via: command },
        });
      }

      return { data: { technicianId, status: result.next, version, storeSeq: null } };
    });
  }

  clockIn(
    ctx: TechnicianCommandContext,
    technicianId: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.clock(ctx, technicianId, 'CLOCK_IN', input);
  }

  clockOut(
    ctx: TechnicianCommandContext,
    technicianId: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.clock(ctx, technicianId, 'CLOCK_OUT', input);
  }

  async lockTechnician(
    ctx: TechnicianCommandContext,
    technicianId: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.runSimple(ctx, technicianId, 'LOCK', 'LOCK', input);
  }

  async unlockTechnician(
    ctx: TechnicianCommandContext,
    technicianId: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.runSimple(ctx, technicianId, 'UNLOCK', 'UNLOCK', input);
  }

  async breakStart(
    ctx: TechnicianCommandContext,
    technicianId: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.runSimple(ctx, technicianId, 'BREAK_START', 'BREAK_START', input);
  }

  async breakEnd(
    ctx: TechnicianCommandContext,
    technicianId: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.runSimple(ctx, technicianId, 'BREAK_END', 'BREAK_END', input);
  }

  private async runSimple(
    ctx: TechnicianCommandContext,
    technicianId: string,
    command: TechnicianCommand,
    reason: string,
    input: { expectedVersion?: number },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const tech = await this.lock(client, ctx.storeId, technicianId);
      this.assertActorCan(ctx, tech);
      if (input.expectedVersion !== undefined && input.expectedVersion !== tech.version) {
        throw new ApiError('VERSION_CONFLICT', 'Technician was modified concurrently.');
      }
      const result = canTransitionTechnician(tech.status, command, {});
      if (!result.ok) throw new ApiError(result.code, result.detail);
      const version = await this.recordTransition(client, ctx, tech, result.next, reason);
      return { data: { technicianId, status: result.next, version } };
    });
  }
}
