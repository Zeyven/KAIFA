import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '@lanxu/contracts';
import { PG_POOL, requirePool } from '../db/pg.module';

/**
 * Device enrollment & binding (spec §10.2 unbound-code console flow, §10.4
 * security: the backend never trusts a client-supplied roomId for kiosk
 * commands — everything resolves through this binding).
 *
 * V1 credential model — BUSINESS POLICY — REQUIRES PILOT VALIDATION:
 * `device_code` doubles as the heartbeat credential (short, displayed on the
 * kiosk). Public endpoints are rate-limited per IP and audited; a stronger
 * per-device key (§4.8 public_key) is the upgrade path.
 */

const ENROLL_WINDOW_MS = 60_000;
const ENROLL_MAX_PER_WINDOW = 10;

interface DeviceRow {
  id: string;
  organization_id: string;
  store_id: string | null;
  room_id: string | null;
  device_code: string;
  status: string;
}

@Injectable()
export class DevicesService {
  private readonly enrollAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private db(): Pool {
    return requirePool(this.pool);
  }

  private enrollBlocked(ip: string): boolean {
    const e = this.enrollAttempts.get(ip);
    return !!e && e.count >= ENROLL_MAX_PER_WINDOW && e.resetAt > Date.now();
  }

  private enrollHit(ip: string): void {
    const now = Date.now();
    const e = this.enrollAttempts.get(ip);
    if (!e || e.resetAt <= now)
      this.enrollAttempts.set(ip, { count: 1, resetAt: now + ENROLL_WINDOW_MS });
    else e.count += 1;
  }

  /** Transactional audit wrapper (record needs a live client, not the pool). */
  private async auditOp(row: {
    actorId: string | null;
    actorType: 'EMPLOYEE' | 'DEVICE';
    action: string;
    resourceId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    ip: string;
    orgId: string;
  }): Promise<void> {
    const client = await this.db().connect();
    try {
      await client.query('BEGIN');
      await this.audit.record(client, {
        organizationId: row.orgId,
        actor: { actorType: row.actorType, actorId: row.actorId ?? undefined, ip: row.ip },
        action: row.action,
        resourceType: 'device',
        resourceId: row.resourceId,
        before: row.before,
        after: row.after,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async genCode(): Promise<string> {
    for (let i = 0; i < 20; i += 1) {
      const seg = (chunk: number): string =>
        Array.from({ length: chunk }, () =>
          '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.charAt(Math.floor(Math.random() * 32)),
        ).join('');
      const code = `LX-R-${seg(5)}`;
      const { rows } = await this.db().query<{ id: string }>(
        `SELECT id FROM devices WHERE device_code = $1`,
        [code],
      );
      if (rows.length === 0) return code;
    }
    throw new ApiError('INTERNAL_ERROR', 'device code space exhausted');
  }

  /** POST /v1/devices/enroll — public (device has no credentials yet). */
  async enroll(
    input: { platform?: string; appVersion?: string; orgCode: string },
    ctx: { ip: string; actor?: string },
  ): Promise<{ data: unknown }> {
    const { rows: orgRows } = await this.db().query<{ id: string; status: string }>(
      `SELECT id, status FROM organizations WHERE code = $1`,
      [input.orgCode],
    );
    const org = orgRows[0];
    if (!org || org.status !== 'ACTIVE') {
      throw new ApiError('NOT_FOUND', 'organization not found');
    }
    const orgId = org.id;
    if (this.enrollBlocked(ctx.ip)) {
      await this.audit.security({
        eventType: 'DEVICE_ENROLL_RATE_LIMITED',
        ip: ctx.ip,
      });
      throw new ApiError('RATE_LIMITED', 'Too many enroll attempts. Try again shortly.');
    }
    this.enrollHit(ctx.ip);
    const deviceCode = await this.genCode();
    const { rows } = await this.db().query<DeviceRow>(
      `INSERT INTO devices (organization_id, device_code, platform, app_version, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING id, organization_id, store_id, room_id, device_code, status`,
      [orgId, deviceCode, input.platform ?? null, input.appVersion ?? null],
    );
    const dev = rows[0]!;
    await this.auditOp({
      actorId: ctx.actor ?? null,
      actorType: ctx.actor ? 'EMPLOYEE' : 'DEVICE',
      action: 'device.enrolled',
      resourceId: dev.id,
      after: { deviceCode: dev.device_code, status: dev.status },
      ip: ctx.ip,
      orgId,
    });
    return { data: { id: dev.id, deviceCode: dev.device_code, status: dev.status } };
  }

  /** GET /v1/devices — store-scoped list (device.read + X-Store-Id). */
  async list(storeId: string): Promise<{ data: unknown }> {
    const { rows } = await this.db().query(
      `SELECT d.id, d.device_type, d.device_code, d.platform, d.app_version, d.status,
              d.store_id, d.room_id, r.code AS room_code, d.last_seen_at, d.enrolled_at,
              d.created_at, d.updated_at, d.credential_version
       FROM devices d
       LEFT JOIN rooms r ON r.id = d.room_id
       WHERE d.store_id = $1
          OR (d.store_id IS NULL
              AND d.organization_id = (SELECT organization_id FROM stores WHERE id = $1))
       ORDER BY d.created_at DESC`,
      [storeId],
    );
    return { data: { items: rows, nextCursor: null } };
  }

  private async loadScoped(deviceId: string, orgId: string): Promise<DeviceRow> {
    const { rows } = await this.db().query<DeviceRow>(
      `SELECT id, organization_id, store_id, room_id, device_code, status
       FROM devices WHERE id = $1 AND organization_id = $2`,
      [deviceId, orgId],
    );
    const dev = rows[0];
    if (!dev) throw new ApiError('NOT_FOUND', 'device not found');
    return dev;
  }

  /**
   * POST /v1/devices/:deviceId/bind — console binding (§10.2 组织→门店→房间).
   * Cross-checks store/room ownership against the DEVICE's org (client-supplied
   * ids are untrusted, §11).
   */
  async bind(
    deviceId: string,
    input: { storeId: string; roomId: string },
    ctx: { orgId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    const dev = await this.loadScoped(deviceId, ctx.orgId);
    if (dev.status === 'REVOKED') {
      throw new ApiError('INVALID_STATE_TRANSITION', 'revoked devices cannot bind');
    }
    const { rows: roomRows } = await this.db().query<{
      id: string;
      store_id: string;
      store_org: string;
      code: string;
    }>(
      `SELECT r.id, r.store_id, s.organization_id AS store_org, r.code
       FROM rooms r JOIN stores s ON s.id = r.store_id
       WHERE r.id = $1`,
      [input.roomId],
    );
    const room = roomRows[0];
    if (!room) throw new ApiError('NOT_FOUND', 'room not found');
    if (room.store_org !== ctx.orgId || room.store_id !== input.storeId) {
      throw new ApiError('UNAUTHORIZED_SCOPE', 'room/store outside organization');
    }
    // one ACTIVE device per room (partial unique + friendly 409)
    const { rows: clash } = await this.db().query<{ id: string; device_code: string }>(
      `SELECT id, device_code FROM devices WHERE room_id = $1 AND status = 'ACTIVE' AND id <> $2`,
      [input.roomId, deviceId],
    );
    if (clash[0]) {
      throw new ApiError(
        'ROOM_BOUND_TO_OTHER_DEVICE',
        `room already has an active device ${clash[0].device_code}`,
      );
    }
    const { rows } = await this.db().query<DeviceRow>(
      `UPDATE devices SET store_id = $1, room_id = $2, status = 'ACTIVE',
              enrolled_at = COALESCE(enrolled_at, now()), updated_at = now()
       WHERE id = $3
       RETURNING id, organization_id, store_id, room_id, device_code, status`,
      [input.storeId, input.roomId, deviceId],
    );
    await this.auditOp({
      actorId: ctx.actorId,
      actorType: 'EMPLOYEE',
      action: 'device.bound',
      resourceId: deviceId,
      before: { status: dev.status, roomId: dev.room_id },
      after: { status: 'ACTIVE', storeId: input.storeId, roomId: input.roomId },
      ip: ctx.ip,
      orgId: ctx.orgId,
    });
    return { data: rows[0] };
  }

  async unbind(
    deviceId: string,
    ctx: { orgId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    const dev = await this.loadScoped(deviceId, ctx.orgId);
    if (dev.status !== 'ACTIVE')
      throw new ApiError('INVALID_STATE_TRANSITION', 'device is not active');
    const { rows } = await this.db().query<DeviceRow>(
      `UPDATE devices SET store_id = NULL, room_id = NULL, status = 'PENDING', updated_at = now()
       WHERE id = $1
       RETURNING id, organization_id, store_id, room_id, device_code, status`,
      [deviceId],
    );
    await this.auditOp({
      actorId: ctx.actorId,
      actorType: 'EMPLOYEE',
      action: 'device.unbound',
      resourceId: deviceId,
      before: { status: 'ACTIVE', storeId: dev.store_id, roomId: dev.room_id },
      after: { status: 'PENDING' },
      ip: ctx.ip,
      orgId: ctx.orgId,
    });
    return { data: rows[0] };
  }

  async setStatus(
    deviceId: string,
    status: 'DISABLED' | 'REVOKED',
    ctx: { orgId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    const dev = await this.loadScoped(deviceId, ctx.orgId);
    if (status === 'REVOKED' && dev.status === 'REVOKED') {
      throw new ApiError('INVALID_STATE_TRANSITION', 'device already revoked');
    }
    if (dev.status === 'REVOKED')
      throw new ApiError('INVALID_STATE_TRANSITION', 'device already revoked');
    const { rows } = await this.db().query<DeviceRow>(
      `UPDATE devices SET status = $1, store_id = CASE WHEN $1 = 'DISABLED' THEN store_id ELSE NULL END,
              room_id = CASE WHEN $1 = 'DISABLED' THEN room_id ELSE NULL END, updated_at = now()
       WHERE id = $2
       RETURNING id, organization_id, store_id, room_id, device_code, status`,
      [status, deviceId],
    );
    await this.auditOp({
      actorId: ctx.actorId,
      actorType: 'EMPLOYEE',
      action: `device.${status.toLowerCase()}`,
      resourceId: deviceId,
      before: { status: dev.status },
      after: { status },
      ip: ctx.ip,
      orgId: ctx.orgId,
    });
    return { data: rows[0] };
  }

  /**
   * GET /v1/devices/heartbeat — kiosk polls with X-Device-Code (V1 credential).
   * Reveals ONLY this device's binding; bumps last_seen_at; never accepts a
   * client roomId (kiosk commands resolve room from this row, §10.4).
   */
  async heartbeat(deviceCode: string, ip: string): Promise<{ data: unknown }> {
    const { rows } = await this.db().query<{
      id: string;
      organization_id: string;
      store_id: string | null;
      room_id: string | null;
      status: string;
    }>(
      `UPDATE devices SET last_seen_at = now(), updated_at = updated_at
       WHERE device_code = $1
       RETURNING id, organization_id, store_id, room_id, status`,
      [deviceCode],
    );
    const dev = rows[0];
    if (!dev) {
      await this.audit.security({
        eventType: 'DEVICE_HEARTBEAT_UNKNOWN',
        ip,
        actorHint: deviceCode,
      });
      throw new ApiError('NOT_FOUND', 'unknown device code');
    }
    if (dev.status === 'REVOKED') {
      throw new ApiError('DEVICE_DISABLED', 'device revoked');
    }
    if (dev.status === 'DISABLED') {
      throw new ApiError('DEVICE_DISABLED', 'device disabled');
    }
    let roomCode: string | null = null;
    if (dev.room_id) {
      const { rows: r } = await this.db().query<{ code: string }>(
        `SELECT code FROM rooms WHERE id = $1`,
        [dev.room_id],
      );
      roomCode = r[0]?.code ?? null;
    }
    return {
      data: {
        deviceId: dev.id,
        status: dev.status,
        bound: dev.status === 'ACTIVE',
        storeId: dev.store_id,
        roomId: dev.room_id,
        roomCode,
        serverTime: new Date().toISOString(),
      },
    };
  }
}
