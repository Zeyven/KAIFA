import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '@lanxu/contracts';
import { canTransition, type RoomCommand, type RoomOperationalState } from '@lanxu/domain';
import { AuditService } from '../audit/audit.service';
import { appendStoreEvent, type StoreEventRef } from '../common/store-events';
import type { AuditActor } from '../common/http-context';
import { PG_POOL, requirePool } from '../db/pg.module';

export interface RoomRow {
  id: string;
  store_id: string;
  code: string;
  name: string;
  capacity: number;
  area_id: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  operational_state: RoomOperationalState;
  current_visit_id: string | null;
  version: number;
}

interface CommandContext {
  storeId: string;
  orgId: string;
  actor: AuditActor;
}

interface CommandResult {
  data: unknown;
}

/**
 * Room domain commands (spec §5.1/§7.3). Every command, in ONE transaction:
 * lock → revalidate guards → state machine → persist → audit → outbox event.
 * No generic status PATCH exists anywhere.
 */
@Injectable()
export class RoomsService {
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

  private async lockRoom(client: PoolClient, storeId: string, roomId: string): Promise<RoomRow> {
    const { rows } = await client.query<RoomRow>(
      `SELECT id, store_id, code, name, capacity, area_id, status, operational_state,
              current_visit_id, version
       FROM rooms WHERE id = $1 AND store_id = $2
       FOR UPDATE`,
      [roomId, storeId],
    );
    if (!rows[0]) throw new ApiError('NOT_FOUND', 'Room not found.');
    return rows[0];
  }

  private checkVersion(room: RoomRow, expectedVersion?: number): void {
    if (expectedVersion !== undefined && expectedVersion !== room.version) {
      throw new ApiError('VERSION_CONFLICT', 'Room was modified concurrently.', [
        {
          path: 'version',
          code: 'VERSION_CONFLICT',
          message: `expected ${expectedVersion}, actual ${room.version}`,
        },
      ]);
    }
  }

  private apply(
    room: RoomRow,
    command: RoomCommand,
    guards: Parameters<typeof canTransition>[2],
  ): RoomOperationalState {
    const result = canTransition(room.operational_state, command, guards);
    if (!result.ok) throw new ApiError(result.code, result.detail);
    return result.next;
  }

  /**
   * Bumps state/version in-tx. `visit` decides current_visit_id explicitly:
   * COALESCE(null, old) would make clearing impossible (move-source bug class).
   */
  private async bumpRoom(
    client: PoolClient,
    room: RoomRow,
    next: RoomOperationalState,
    extra: {
      visit?: { set: string } | { clear: true };
      status?: 'ACTIVE' | 'INACTIVE';
    } = {},
  ): Promise<number> {
    const visitOp = extra.visit && 'set' in extra.visit ? 'set' : extra.visit ? 'clear' : 'keep';
    const visitValue = extra.visit && 'set' in extra.visit ? extra.visit.set : null;
    const { rows } = await client.query<{ version: number }>(
      `UPDATE rooms
       SET operational_state = $2,
           current_visit_id = CASE $3
             WHEN 'set' THEN $4::uuid
             WHEN 'clear' THEN NULL
             ELSE current_visit_id
           END,
           status = COALESCE($5, status),
           version = version + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING version`,
      [room.id, next, visitOp, visitValue, extra.status ?? null],
    );
    return rows[0]!.version;
  }

  async list(storeId: string): Promise<CommandResult> {
    const { rows } = await this.db().query<RoomRow>(
      `SELECT id, store_id, code, name, capacity, area_id, status, operational_state,
              current_visit_id, version
       FROM rooms WHERE store_id = $1 ORDER BY code`,
      [storeId],
    );
    return { data: { items: rows, nextCursor: null } };
  }

  async get(storeId: string, roomId: string): Promise<CommandResult> {
    const { rows } = await this.db().query<RoomRow>(
      `SELECT id, store_id, code, name, capacity, area_id, status, operational_state,
              current_visit_id, version
       FROM rooms WHERE id = $1 AND store_id = $2`,
      [roomId, storeId],
    );
    if (!rows[0]) throw new ApiError('NOT_FOUND', 'Room not found.');
    return { data: rows[0] };
  }

  /** POST /v1/rooms/:roomId/open — VACANT_CLEAN → OCCUPIED_WAITING_SERVICE (+visit row). */
  async open(
    ctx: CommandContext,
    roomId: string,
    input: { guestCount: number; expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.tx(async (client) => {
      const room = await this.lockRoom(client, ctx.storeId, roomId);
      this.checkVersion(room, input.expectedVersion);

      if (room.status !== 'ACTIVE') {
        throw new ApiError('ROOM_NOT_ELIGIBLE', 'Room is administratively inactive.');
      }
      if (room.current_visit_id) {
        throw new ApiError('ROOM_OCCUPIED', 'Room already has an active visit.');
      }
      const next = this.apply(room, 'OPEN_VISIT', { hasActiveVisit: true });

      const dateRes = await client.query<{ business_date: string }>(
        `SELECT ((now() AT TIME ZONE s.timezone)::date
                 - CASE WHEN (now() AT TIME ZONE s.timezone)::time < s.business_date_cutoff_time
                        THEN 1 ELSE 0 END)::text AS business_date
         FROM stores s WHERE s.id = $1`,
        [ctx.storeId],
      );
      const businessDate = dateRes.rows[0]?.business_date;
      if (!businessDate) throw new ApiError('NOT_FOUND', 'Store not found.');

      const visitRes = await client.query<{ id: string }>(
        `INSERT INTO visits (store_id, room_id, guest_count, opened_by, business_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ctx.storeId, room.id, input.guestCount, ctx.actor.actorId ?? null, businessDate],
      );
      const visitId = visitRes.rows[0]!.id;
      const version = await this.bumpRoom(client, room, next, { visit: { set: visitId } });

      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'room.open',
        resourceType: 'room',
        resourceId: room.id,
        before: { operationalState: room.operational_state },
        after: { operationalState: next, visitId, guestCount: input.guestCount },
      });
      const event = await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'visit.opened',
        aggregateType: 'visit',
        aggregateId: visitId,
        payload: { roomId: room.id, operationalState: next, guestCount: input.guestCount },
      });

      return {
        data: {
          roomId: room.id,
          visitId,
          operationalState: next,
          version,
          businessDate,
          storeSeq: event.storeSeq,
          eventId: event.eventId,
        },
      };
    });
  }

  /** POST /v1/rooms/:roomId/move — relocate active visit; vacated room → DIRTY. */
  async move(
    ctx: CommandContext,
    roomId: string,
    input: { toRoomId: string; expectedVersion?: number },
  ): Promise<CommandResult> {
    if (roomId === input.toRoomId) {
      throw new ApiError('VALIDATION_FAILED', 'Source and target rooms are identical.');
    }
    return this.tx(async (client) => {
      // lock in stable id order to avoid deadlocks between concurrent moves
      const ids = [roomId, input.toRoomId].sort();
      const lockRes = await client.query<RoomRow>(
        `SELECT id, store_id, code, name, capacity, area_id, status, operational_state,
                current_visit_id, version
         FROM rooms WHERE store_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id FOR UPDATE`,
        [ctx.storeId, ids],
      );
      const source = lockRes.rows.find((r) => r.id === roomId);
      const target = lockRes.rows.find((r) => r.id === input.toRoomId);
      if (!source || !target) throw new ApiError('NOT_FOUND', 'Room not found.');
      this.checkVersion(source, input.expectedVersion);

      if (!source.current_visit_id) {
        throw new ApiError('ROOM_NOT_ELIGIBLE', 'Source room has no active visit.');
      }
      if (target.status !== 'ACTIVE') {
        throw new ApiError('ROOM_NOT_ELIGIBLE', 'Target room is inactive.');
      }
      if (target.current_visit_id) {
        throw new ApiError('ROOM_OCCUPIED', 'Target room already has an active visit.');
      }
      // target must be clean (or its own honored reservation) — BUSINESS POLICY
      if (!['VACANT_CLEAN', 'RESERVED'].includes(target.operational_state)) {
        throw new ApiError(
          'ROOM_NOT_ELIGIBLE',
          `Target not movable-into: ${target.operational_state}`,
        );
      }

      const nextSource = this.apply(source, 'VISIT_MOVED', { hasActiveVisit: true });
      const nextTarget = this.apply(target, 'OPEN_VISIT', { hasActiveVisit: true });
      const visitId = source.current_visit_id;

      await client.query(`UPDATE visits SET room_id = $2, updated_at = now() WHERE id = $1`, [
        visitId,
        target.id,
      ]);
      const sourceVersion = await this.bumpRoom(client, source, nextSource, {
        visit: { clear: true },
      });
      const targetVersion = await this.bumpRoom(client, target, nextTarget, {
        visit: { set: visitId },
      });

      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action: 'room.move',
        resourceType: 'visit',
        resourceId: visitId,
        before: { fromRoomId: source.id, toRoomId: target.id },
        after: { visitId, sourceState: nextSource, targetState: nextTarget },
      });
      const moved = await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'visit.moved',
        aggregateType: 'visit',
        aggregateId: visitId,
        payload: { fromRoomId: source.id, toRoomId: target.id },
      });
      for (const [rid, state, ver] of [
        [source.id, nextSource, sourceVersion],
        [target.id, nextTarget, targetVersion],
      ] as const) {
        await appendStoreEvent(client, {
          storeId: ctx.storeId,
          type: 'room.updated',
          aggregateType: 'room',
          aggregateId: rid,
          payload: { operationalState: state, version: ver },
          version: ver,
        });
      }

      return {
        data: {
          visitId,
          from: { roomId: source.id, operationalState: nextSource, version: sourceVersion },
          to: { roomId: target.id, operationalState: nextTarget, version: targetVersion },
          storeSeq: moved.storeSeq,
        },
      };
    });
  }

  /** Generic private command for cleaning / maintenance / disable chains. */
  private async simpleCommand(
    ctx: CommandContext,
    roomId: string,
    command: RoomCommand,
    action: string,
    guards: Parameters<typeof canTransition>[2],
    input: { expectedVersion?: number },
    extra: { status?: 'ACTIVE' | 'INACTIVE' } = {},
    eventPayload: Record<string, unknown> = {},
  ): Promise<CommandResult> {
    return this.tx(async (client) => {
      const room = await this.lockRoom(client, ctx.storeId, roomId);
      this.checkVersion(room, input.expectedVersion);
      const next = this.apply(room, command, guards);
      const version = await this.bumpRoom(client, room, next, extra);

      await this.audit.record(client, {
        organizationId: ctx.orgId,
        storeId: ctx.storeId,
        actor: ctx.actor,
        action,
        resourceType: 'room',
        resourceId: room.id,
        before: { operationalState: room.operational_state, status: room.status },
        after: { operationalState: next, ...eventPayload },
        reason: eventPayload.reason as string | undefined,
      });
      const event = await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'room.updated',
        aggregateType: 'room',
        aggregateId: room.id,
        payload: { operationalState: next, version, ...eventPayload },
        version,
      });
      return {
        data: { roomId: room.id, operationalState: next, version, storeSeq: event.storeSeq },
      };
    });
  }

  cleaningStart(
    ctx: CommandContext,
    roomId: string,
    input: { expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.simpleCommand(
      ctx,
      roomId,
      'CLEANING_STARTED',
      'room.cleaning_started',
      { cleanerAuthorized: true },
      input,
    );
  }

  cleaningComplete(
    ctx: CommandContext,
    roomId: string,
    input: { checklistPassed: boolean; expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.simpleCommand(
      ctx,
      roomId,
      'CLEANING_COMPLETED',
      'room.cleaning_completed',
      { checklistPassed: input.checklistPassed },
      input,
      {},
      { checklistPassed: input.checklistPassed },
    );
  }

  maintenanceStart(
    ctx: CommandContext,
    roomId: string,
    input: { expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.simpleCommand(
      ctx,
      roomId,
      'MAINTENANCE_START',
      'room.maintenance_started',
      {},
      input,
    );
  }

  maintenanceEnd(
    ctx: CommandContext,
    roomId: string,
    input: { inspectionPassed: boolean; expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.simpleCommand(
      ctx,
      roomId,
      'MAINTENANCE_END',
      'room.maintenance_ended',
      { inspectionPassed: input.inspectionPassed },
      input,
      {},
      { inspectionPassed: input.inspectionPassed },
    );
  }

  disable(
    ctx: CommandContext,
    roomId: string,
    input: { expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.simpleCommand(ctx, roomId, 'DISABLE', 'room.disabled', {}, input, {
      status: 'INACTIVE',
    });
  }

  enable(
    ctx: CommandContext,
    roomId: string,
    input: { expectedVersion?: number },
  ): Promise<CommandResult> {
    return this.simpleCommand(ctx, roomId, 'ENABLE', 'room.enabled', {}, input, {
      status: 'ACTIVE',
    });
  }
}

export type { StoreEventRef };
