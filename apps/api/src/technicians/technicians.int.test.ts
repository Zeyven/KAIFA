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
 * Phase 04 integration — technician commands over real HTTP + real PG:
 * clock-in/out queue lifecycle, self vs tech.manage object-level gating,
 * lock/unlock/break chains, version conflicts, append-only status history.
 */

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
}

describe('technician commands (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let t: TenantFixture;
  let bossToken = '';
  let aideToken = '';
  let clerkToken = '';

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

  async function login(username: string): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/v1/auth/login',
      body: { orgCode: t.orgCode, username, password: t.password },
    });
    expect(res.status).toBe(200);
    return (res.body.data as { token: string }).token;
  }

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-tech-');
    const raw = createPool(harness.connectionString, { max: 4 });
    await new Migrator(raw).up();
    t = await seedTenant(raw);
    db = raw;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 4000,
        LOG_LEVEL: 'fatal',
        DATABASE_URL: harness.connectionString,
        JWT_SECRET: 'h'.repeat(48),
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

    bossToken = await login(t.bossUsername);
    aideToken = await login(t.aideUsername);
    clerkToken = await login(t.clerkUsername);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('GET /v1/technicians lists store-scoped technicians (tech.read)', async () => {
    const res = await call({ url: '/v1/technicians', token: bossToken, storeId: t.storeA });
    expect(res.status).toBe(200);
    apiSuccessSchema.parse(res.body);
    const items = (res.body.data as { items: Array<{ technician_no: string; status: string }> })
      .items;
    expect(items).toHaveLength(4);
    expect(items.every((x) => x.status === 'OFF_DUTY')).toBe(true);
  });

  it('clock-in (manage) → AVAILABLE + queue entry ENQUEUED + history + events + audit', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/clock-in`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'AVAILABLE' });

    const entry = await db.query<{ state: string; position_key: string }>(
      `SELECT state, position_key FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]).toMatchObject({ state: 'ACTIVE' });

    const hist = await db.query<{ from_status: string; to_status: string; reason_code: string }>(
      `SELECT from_status, to_status, reason_code FROM technician_status_history
       WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(hist.rows).toEqual([
      { from_status: 'OFF_DUTY', to_status: 'AVAILABLE', reason_code: 'CLOCK_IN' },
    ]);

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE store_id = $1 ORDER BY store_seq`,
      [t.storeA],
    );
    const types = events.rows.map((e) => e.event_type);
    expect(types).toContain('technician.status_changed');
    expect(types).toContain('technician.queue_changed');

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'technician.clock_in'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('double clock-in → 422 INVALID_STATE_TRANSITION (no double enqueue)', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/clock-in`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { code: string }).code).toBe('INVALID_STATE_TRANSITION');
    const entries = await db.query(
      `SELECT 1 FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(entries.rows).toHaveLength(1);
  });

  it('clock-in without active shift → 403 FORBIDDEN (spec §6.2 on-shift guard)', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech4}/clock-in`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('FORBIDDEN');
  });

  it("aide cannot clock in ANOTHER employee's technician (no tech.manage) → 403", async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech2}/clock-in`,
      token: aideToken,
      storeId: t.storeA,
      body: {},
    });
    expect(res.status).toBe(403);
    expect((res.body.error as { message: string }).message).toContain('tech.manage');
  });

  it('self-service: aide clocks own technician in and out without tech.manage', async () => {
    const inRes = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech3}/clock-in`,
      token: aideToken,
      storeId: t.storeA,
      body: {},
    });
    expect(inRes.status).toBe(201);
    expect(inRes.body.data).toMatchObject({ status: 'AVAILABLE' });

    const outRes = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech3}/clock-out`,
      token: aideToken,
      storeId: t.storeA,
      body: {},
    });
    expect(outRes.status).toBe(201);
    expect(outRes.body.data).toMatchObject({ status: 'OFF_DUTY' });

    // queue entry removed (DEQUEUED) on clock-out
    const entry = await db.query<{ state: string }>(
      `SELECT state FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech3],
    );
    expect(entry.rows[0]!.state).toBe('REMOVED');
  });

  it('lock/unlock chain (TECHNICIAN_LOCKED reported for assign attempts)', async () => {
    const lock = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/lock`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(lock.status).toBe(201);
    expect(lock.body.data).toMatchObject({ status: 'LOCKED' });

    const unlock = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/unlock`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(unlock.status).toBe(201);
    expect(unlock.body.data).toMatchObject({ status: 'AVAILABLE' });
  });

  it('break start/end chain', async () => {
    const start = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/break/start`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(start.status).toBe(201);
    expect(start.body.data).toMatchObject({ status: 'BREAK' });

    const end = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/break/end`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(end.status).toBe(201);
    expect(end.body.data).toMatchObject({ status: 'AVAILABLE' });
  });

  it('stale expectedVersion → 409 VERSION_CONFLICT', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/clock-out`,
      token: bossToken,
      storeId: t.storeA,
      body: { expectedVersion: 99 },
    });
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('VERSION_CONFLICT');
  });

  it('cross-store: store-B clerk sees empty list and 404s store-A technician ids', async () => {
    const list = await call({ url: '/v1/technicians', token: clerkToken, storeId: t.storeB });
    expect(list.status).toBe(200);
    expect((list.body.data as { items: unknown[] }).items).toHaveLength(0);

    const direct = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/clock-in`,
      token: clerkToken,
      storeId: t.storeB,
      body: {},
    });
    expect(direct.status).toBe(404);
    apiErrorSchema.parse(direct.body);
  });

  it('append-only: technician_status_history direct UPDATE/DELETE rejected (23001)', async () => {
    await expect(
      db.query(`UPDATE technician_status_history SET to_status = 'AVAILABLE'`),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(db.query(`DELETE FROM technician_status_history`)).rejects.toMatchObject({
      code: '23001',
    });
    const ok = await db.query(`SELECT 1 FROM technician_status_history`);
    expect(ok.rows.length).toBeGreaterThan(0);
  });

  it('clock-out (manage) → OFF_DUTY + queue entry REMOVED (DEQUEUED event)', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/clock-out`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'OFF_DUTY' });

    const entry = await db.query<{ state: string }>(
      `SELECT state FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(entry.rows[0]!.state).toBe('REMOVED');
    const dequeued = await db.query<{ event_type: string }>(
      `SELECT event_type FROM technician_queue_events qe
       JOIN technician_queue_entries e ON e.id = qe.queue_entry_id
       WHERE e.technician_id = $1 AND qe.event_type = 'DEQUEUED'`,
      [t.tech1],
    );
    expect(dequeued.rows).toHaveLength(1);
  });

  it('login envelope sanity for success schema (guards on non-GET)', async () => {
    const bad = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech1}/clock-in`,
      storeId: t.storeA,
      body: {},
    });
    expect(bad.status).toBe(401);
    apiErrorSchema.parse(bad.body);
    expect((bad.body.error as { code: string }).code).toBe('UNAUTHENTICATED');
  });
});
