import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { startPgHarness, seedTenant, type PgHarness, type TenantFixture } from '@lanxu/testkit';
import { apiErrorSchema, apiSuccessSchema } from '@lanxu/contracts';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { configureApi } from '../setup';

/**
 * Phase 03 integration — room state machine through the real HTTP layer on
 * real PostgreSQL: open/double-open, move (incl. DIRTY gap-fill), cleaning
 * chain, optimistic-lock 409s, audit + storeSeq outbox evidence, append-only
 * DB triggers, and command-endpoint-only mutation (no generic PATCH).
 */

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
}

describe('room commands (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let tenant: TenantFixture;
  let token = '';

  async function call(
    opts: InjectOpts,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.storeId) headers['x-store-id'] = opts.storeId;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: opts.method ?? 'GET',
        url: opts.url,
        headers,
        ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
      });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
  }

  function expectError(
    res: { status: number; body: Record<string, unknown> },
    code: string,
    status?: number,
  ) {
    const parsed = apiErrorSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect((res.body.error as { code: string }).code).toBe(code);
    if (status !== undefined) expect(res.status).toBe(status);
  }

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-rooms-');
    const raw = createPool(harness.connectionString, { max: 4 });
    await new Migrator(raw).up();
    tenant = await seedTenant(raw);
    db = raw;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 4000,
        LOG_LEVEL: 'fatal',
        DATABASE_URL: harness.connectionString,
        JWT_SECRET: 'r'.repeat(48),
        JWT_ACCESS_TTL_SECONDS: 3600,
        PAYMENT_PROVIDER: 'fake',
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(createFastifyOptions()),
    );
    configureApi(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const login = await call({
      method: 'POST',
      url: '/v1/auth/login',
      body: { orgCode: tenant.orgCode, username: tenant.bossUsername, password: tenant.password },
    });
    expect(login.status).toBe(200);
    token = (login.body.data as { token: string }).token;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('GET /v1/rooms lists store-scoped floor state with versions', async () => {
    const res = await call({ url: '/v1/rooms', token, storeId: tenant.storeA });
    expect(res.status).toBe(200);
    apiSuccessSchema.parse(res.body);
    const items = (
      res.body.data as { items: Array<{ id: string; operational_state: string; version: number }> }
    ).items;
    expect(items).toHaveLength(3);
    const clean1 = items.find((r) => r.id === tenant.roomClean1)!;
    expect(clean1.operational_state).toBe('VACANT_CLEAN');
    expect(clean1.version).toBe(1);
  });

  it('open a vacant room → OCCUPIED_WAITING_SERVICE + visit row + audit + outbox storeSeq', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/open`,
      token,
      storeId: tenant.storeA,
      body: { guestCount: 2 },
    });
    expect(res.status).toBe(201);
    const data = res.body.data as {
      visitId: string;
      operationalState: string;
      version: number;
      businessDate: string;
      storeSeq: number;
      eventId: string;
    };
    expect(data.operationalState).toBe('OCCUPIED_WAITING_SERVICE');
    expect(data.version).toBe(2);
    expect(data.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.storeSeq).toBe(1);

    const visit = await db.query<{
      status: string;
      guest_count: number;
      room_id: string;
      opened_by: string | null;
    }>(`SELECT status, guest_count, room_id, opened_by FROM visits WHERE id = $1`, [data.visitId]);
    expect(visit.rows[0]).toMatchObject({
      status: 'ACTIVE',
      guest_count: 2,
      room_id: tenant.roomClean1,
    });
    expect(visit.rows[0]!.opened_by).toBe(tenant.bossEmployeeId);

    const audit = await db.query<{ action: string; resource_id: string; actor_id: string }>(
      `SELECT action, resource_id, actor_id FROM audit_logs WHERE action = 'room.open'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.resource_id).toBe(tenant.roomClean1);
    expect(audit.rows[0]!.actor_id).toBe(tenant.bossEmployeeId);

    const outbox = await db.query<{
      event_type: string;
      store_seq: number;
      aggregate_type: string;
    }>(
      `SELECT event_type, store_seq::int AS store_seq, aggregate_type
       FROM outbox_events WHERE store_id = $1`,
      [tenant.storeA],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      event_type: 'visit.opened',
      store_seq: 1,
      aggregate_type: 'visit',
    });

    const store = await db.query<{ last_event_seq: number }>(
      `SELECT last_event_seq FROM stores WHERE id = $1`,
      [tenant.storeA],
    );
    expect(Number(store.rows[0]!.last_event_seq)).toBe(1);
  });

  it('double-open same room → 422 ROOM_OCCUPIED, state unchanged', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/open`,
      token,
      storeId: tenant.storeA,
      body: {},
    });
    expectError(res, 'ROOM_OCCUPIED', 422);
    const room = await db.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1`,
      [tenant.roomClean1],
    );
    expect(room.rows[0]!.operational_state).toBe('OCCUPIED_WAITING_SERVICE');
  });

  it('optimistic lock: stale expectedVersion → 409 VERSION_CONFLICT (no partial write)', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean2}/disable`,
      token,
      storeId: tenant.storeA,
      body: { expectedVersion: 99 },
    });
    expectError(res, 'VERSION_CONFLICT', 409);
    const room = await db.query<{ status: string; version: number }>(
      `SELECT status, version FROM rooms WHERE id = $1`,
      [tenant.roomClean2],
    );
    expect(room.rows[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
    // no audit row for the failed attempt
    const audit = await db.query(`SELECT 1 FROM audit_logs WHERE action = 'room.disabled'`);
    expect(audit.rows).toHaveLength(0);
  });

  it('move visit → target occupied, source DIRTY, visit relocated, events appended', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/move`,
      token,
      storeId: tenant.storeA,
      body: { toRoomId: tenant.roomClean2 },
    });
    expect(res.status).toBe(201);
    const data = res.body.data as {
      visitId: string;
      from: { operationalState: string };
      to: { operationalState: string; version: number };
    };
    expect(data.from.operationalState).toBe('DIRTY');
    expect(data.to.operationalState).toBe('OCCUPIED_WAITING_SERVICE');

    const rooms = await db.query<{
      id: string;
      operational_state: string;
      current_visit_id: string | null;
    }>(
      `SELECT id, operational_state, current_visit_id FROM rooms WHERE store_id = $1 ORDER BY code`,
      [tenant.storeA],
    );
    const r101 = rooms.rows.find((r) => r.id === tenant.roomClean1)!;
    const r102 = rooms.rows.find((r) => r.id === tenant.roomClean2)!;
    expect(r101.operational_state).toBe('DIRTY');
    expect(r101.current_visit_id).toBeNull();
    expect(r102.current_visit_id).toBe(data.visitId);

    const visit = await db.query<{ room_id: string }>(`SELECT room_id FROM visits WHERE id = $1`, [
      data.visitId,
    ]);
    expect(visit.rows[0]!.room_id).toBe(tenant.roomClean2);

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE store_id = $1 ORDER BY store_seq`,
      [tenant.storeA],
    );
    const types = events.rows.map((e) => e.event_type);
    expect(types).toContain('visit.moved');
    expect(types.filter((t) => t === 'room.updated')).toHaveLength(2);
  });

  it('move into dirty/occupied rooms rejected (422), source DIRTY cannot move (422)', async () => {
    // roomDirty fixture (R103) is DIRTY — not a legal move target
    const intoDirty = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean2}/move`,
      token,
      storeId: tenant.storeA,
      body: { toRoomId: tenant.roomDirty },
    });
    expectError(intoDirty, 'ROOM_NOT_ELIGIBLE', 422);

    // source DIRTY (R101) has no active visit
    const fromDirty = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/move`,
      token,
      storeId: tenant.storeA,
      body: { toRoomId: tenant.roomDirty },
    });
    expectError(fromDirty, 'ROOM_NOT_ELIGIBLE', 422);

    // occupied target blocked
    const intoOccupied = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomDirty}/move`,
      token,
      storeId: tenant.storeA,
      body: { toRoomId: tenant.roomClean2 },
    });
    expect(intoOccupied.status).toBeGreaterThanOrEqual(400);
  });

  it('cleaning chain: DIRTY → CLEANING → VACANT_CLEAN with guards (checklist blocks)', async () => {
    const start = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/cleaning/start`,
      token,
      storeId: tenant.storeA,
      body: {},
    });
    expect(start.status).toBe(201);
    expect((start.body.data as { operationalState: string }).operationalState).toBe('CLEANING');

    // checklist must pass before completion (guard, not UI validation) —
    // edge exists, guard fails → ROOM_NOT_ELIGIBLE (machine-readable)
    const fail = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/cleaning/complete`,
      token,
      storeId: tenant.storeA,
      body: { checklistPassed: false },
    });
    expectError(fail, 'ROOM_NOT_ELIGIBLE', 422);

    const done = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean1}/cleaning/complete`,
      token,
      storeId: tenant.storeA,
      body: { checklistPassed: true },
    });
    expect(done.status).toBe(201);
    expect((done.body.data as { operationalState: string }).operationalState).toBe('VACANT_CLEAN');
    expect((done.body.data as { version: number }).version).toBe(5);
  });

  it('cleaning-start on occupied room → 422 INVALID_STATE_TRANSITION', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomClean2}/cleaning/start`,
      token,
      storeId: tenant.storeA,
      body: {},
    });
    expectError(res, 'INVALID_STATE_TRANSITION', 422);
  });

  it('maintenance + disable/enable chains (status column follows machine)', async () => {
    const start = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomDirty}/maintenance/start`,
      token,
      storeId: tenant.storeA,
      body: {},
    });
    expect(start.status).toBe(201);
    expect((start.body.data as { operationalState: string }).operationalState).toBe('MAINTENANCE');

    const end = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomDirty}/maintenance/end`,
      token,
      storeId: tenant.storeA,
      body: { inspectionPassed: true },
    });
    expect(end.status).toBe(201);
    // spec §5.1: MAINTENANCE_END → VACANT_CLEAN (inspection passed restores clean)
    expect((end.body.data as { operationalState: string }).operationalState).toBe('VACANT_CLEAN');
    expect((end.body.data as { version: number }).version).toBe(3);

    const disable = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomDirty}/disable`,
      token,
      storeId: tenant.storeA,
      body: {},
    });
    expect(disable.status).toBe(201);
    const afterDisable = await db.query<{ status: string; operational_state: string }>(
      `SELECT status, operational_state FROM rooms WHERE id = $1`,
      [tenant.roomDirty],
    );
    expect(afterDisable.rows[0]).toMatchObject({
      status: 'INACTIVE',
      operational_state: 'DISABLED',
    });

    const enable = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomDirty}/enable`,
      token,
      storeId: tenant.storeA,
      body: {},
    });
    expect(enable.status).toBe(201);
    const afterEnable = await db.query<{ status: string }>(
      `SELECT status FROM rooms WHERE id = $1`,
      [tenant.roomDirty],
    );
    expect(afterEnable.rows[0]!.status).toBe('ACTIVE');
  });

  it('no generic status PATCH exists (command-endpoint-only contract)', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/v1/rooms/${tenant.roomClean1}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-store-id': tenant.storeA,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ operationalState: 'VACANT_CLEAN' }),
      });
    expect(res.statusCode).toBe(404);
    apiErrorSchema.parse(JSON.parse(res.body));
  });

  it('append-only triggers: direct UPDATE/DELETE on audit_logs and outbox rejected by DB', async () => {
    // SQLSTATE 23001 restrict_violation (RAISE ... USING ERRCODE restrict_violation)
    await expect(db.query(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toMatchObject({
      code: '23001',
    });
    await expect(db.query(`DELETE FROM audit_logs`)).rejects.toMatchObject({ code: '23001' });
    await expect(db.query(`UPDATE outbox_events SET store_seq = 999`)).rejects.toMatchObject({
      code: '23001',
    });
    // published_at IS allowed to change (workflow field)
    const upd = await db.query(
      `UPDATE outbox_events SET published_at = now() WHERE store_id = $1`,
      [tenant.storeA],
    );
    expect(upd.rowCount).toBeGreaterThanOrEqual(4);
  });

  it('cross-store object access → 404; room not leaking existence', async () => {
    const clerkLogin = await call({
      method: 'POST',
      url: '/v1/auth/login',
      body: { orgCode: tenant.orgCode, username: tenant.clerkUsername, password: tenant.password },
    });
    const clerkToken = (clerkLogin.body.data as { token: string }).token;
    const res = await call({
      url: `/v1/rooms/${tenant.roomClean1}`,
      token: clerkToken,
      storeId: tenant.storeB,
    });
    expectError(res, 'NOT_FOUND', 404);
  });
});
