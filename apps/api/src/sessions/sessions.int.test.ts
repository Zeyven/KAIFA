import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { hashPassword } from '@lanxu/domain';
import { startPgHarness, seedTenant, type PgHarness, type TenantFixture } from '@lanxu/testkit';
import { apiErrorSchema, apiSuccessSchema } from '@lanxu/contracts';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { configureApi } from '../setup';

/**
 * Phase 06 integration — Visit/ServiceSession over real HTTP + real PG18:
 * visit via room open + one-active-per-room invariant, session lifecycle
 * (assign → acknowledge → arrive → start → extend → complete) with mirrored
 * technician progression and room machine sync, one-active-session-per-tech,
 * identity-gated self-service vs service.manage, change-technician/service,
 * terminate exception path, cross-store 404s, append-only session events.
 */

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
}

describe('visit + service sessions (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let t: TenantFixture;
  let bossToken = '';
  let clerkToken = '';
  /** worker: role.employee at store A (service.read only) + own technician. */
  let workerToken = '';
  let workerTechId = '';

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

  const bossPost = (url: string, body: unknown = {}) =>
    call({ method: 'POST', url, token: bossToken, storeId: t.storeA, body });

  function data<T>(res: { body: Record<string, unknown> }): T {
    return res.body.data as T;
  }

  // shared state across linear flow
  let visit1Room = '';
  let session1 = '';
  let session2 = '';
  let visit2Room = '';
  let session3 = '';

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-sess-');
    const raw = createPool(harness.connectionString, { max: 4 });
    await new Migrator(raw).up();
    t = await seedTenant(raw);
    db = raw;

    const passwordHash = await hashPassword(t.password);
    const w = await raw.query<{ user_id: string; technician_id: string }>(
      `WITH u AS (
         INSERT INTO users (organization_id, username, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE') RETURNING id
       ), e AS (
         INSERT INTO employees (organization_id, store_id, user_id, employee_no, display_name, employee_type)
         SELECT $1, $4, u.id, 'W-001', 'Worker Test', 'TECHNICIAN' FROM u RETURNING id
       ), r AS (
         INSERT INTO employee_roles (employee_id, role_id, store_id)
         SELECT e.id, ro.id, $4 FROM e JOIN roles ro ON ro.code = 'role.employee'
       ), tc AS (
         INSERT INTO technicians (employee_id, store_id, technician_no, queue_enabled)
         SELECT e.id, $4, 'TW1', false FROM e RETURNING id
       )
       SELECT u.id AS user_id, tc.id AS technician_id FROM u, tc`,
      [t.orgId, `worker_${t.orgCode.toLowerCase()}`, passwordHash, t.storeA],
    );
    workerTechId = w.rows[0]!.technician_id;
    await raw.query(
      `INSERT INTO technician_skills (technician_id, service_variant_id, skill_level, enabled)
       VALUES ($1, $2, 3, true)`,
      [workerTechId, t.serviceVariantId2],
    );
    await raw.query(`UPDATE technicians SET status = 'AVAILABLE' WHERE id = $1`, [workerTechId]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 4000,
        LOG_LEVEL: 'fatal',
        DATABASE_URL: harness.connectionString,
        JWT_SECRET: 'v'.repeat(48),
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
    clerkToken = await login(t.clerkUsername);
    workerToken = await login(`worker_${t.orgCode.toLowerCase()}`);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('room open creates the ACTIVE visit (visit.opened event) and re-open is rejected', async () => {
    const open = await bossPost(`/v1/rooms/${t.roomClean1}/open`, { guestCount: 2 });
    expect(open.status).toBe(201);
    const d = data<{ visitId: string; operationalState: string }>(open);
    expect(d.operationalState).toBe('OCCUPIED_WAITING_SERVICE');
    visit1Room = t.roomClean1;

    const visit = await db.query<{ id: string; status: string; guest_count: number }>(
      `SELECT id, status, guest_count FROM visits WHERE id = $1`,
      [d.visitId],
    );
    expect(visit.rows[0]).toMatchObject({ status: 'ACTIVE', guest_count: 2 });
    const ev = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE store_id = $1 AND event_type = 'visit.opened'`,
      [t.storeA],
    );
    expect(ev.rows).toHaveLength(1);

    const again = await bossPost(`/v1/rooms/${t.roomClean1}/open`, {});
    expect(again.status).toBe(422);
    apiErrorSchema.parse(again.body);

    // invariant §4.9 at DB level: second ACTIVE visit for the room → 23505
    await expect(
      db.query(
        `INSERT INTO visits (store_id, room_id, guest_count, business_date)
         VALUES ($1, $2, 1, current_date)`,
        [t.storeA, t.roomClean1],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('create session DRAFT (no technician) + GET', async () => {
    const create = await bossPost('/v1/service-sessions', {
      roomId: visit1Room,
      serviceVariantId: t.serviceVariantId,
    });
    expect(create.status).toBe(201);
    const d = data<{
      sessionId: string;
      status: string;
      priceCents: number;
      durationMinutes: number;
    }>(create);
    expect(d).toMatchObject({
      status: 'DRAFT',
      priceCents: 29800,
      durationMinutes: 90,
    });
    session1 = d.sessionId;

    const get = await call({
      url: `/v1/service-sessions/${session1}`,
      token: bossToken,
      storeId: t.storeA,
    });
    expect(get.status).toBe(200);
    apiSuccessSchema.parse(get.body);
  });

  it('assign → session ASSIGNED, technician ASSIGNED, queue entry ASSIGNED, service.assigned event + audit', async () => {
    // tech1 must be on the clock (queue entry ACTIVE) — boss manages
    expect((await bossPost(`/v1/technicians/${t.tech1}/clock-in`)).status).toBe(201);

    const res = await bossPost(`/v1/service-sessions/${session1}/assign`, {
      technicianId: t.tech1,
    });
    expect(res.status).toBe(201);
    expect(data<{ status: string }>(res)).toMatchObject({ status: 'ASSIGNED' });

    const tech = await db.query<{ status: string }>(
      `SELECT status FROM technicians WHERE id = $1`,
      [t.tech1],
    );
    expect(tech.rows[0]!.status).toBe('ASSIGNED');
    const entry = await db.query<{ state: string }>(
      `SELECT state FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(entry.rows[0]!.state).toBe('ASSIGNED');

    const ev = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE store_id = $1`,
      [t.storeA],
    );
    const types = ev.rows.map((r) => r.event_type);
    expect(types).toContain('service.assigned');
    expect(types).toContain('technician.status_changed');
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action IN ('service.create','service.assign')`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('one active session per technician: second assign → 422 TECHNICIAN_NOT_AVAILABLE', async () => {
    const second = await bossPost('/v1/service-sessions', {
      roomId: visit1Room,
      serviceVariantId: t.serviceVariantId,
    });
    session2 = data<{ sessionId: string }>(second).sessionId;
    const res = await bossPost(`/v1/service-sessions/${session2}/assign`, {
      technicianId: t.tech1,
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { code: string }).code).toBe('TECHNICIAN_NOT_AVAILABLE');
  });

  it('invalid transition: complete from ASSIGNED → 422; stale expectedVersion → 409', async () => {
    const bad = await bossPost(`/v1/service-sessions/${session1}/complete`, {});
    expect(bad.status).toBe(422);
    expect((bad.body.error as { code: string }).code).toBe('INVALID_STATE_TRANSITION');

    const stale = await bossPost(`/v1/service-sessions/${session1}/acknowledge`, {
      expectedVersion: 99,
    });
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe('VERSION_CONFLICT');
  });

  it('object-level: worker (role.employee, not self) is denied lifecycle commands → 403', async () => {
    const res = await call({
      method: 'POST',
      url: `/v1/service-sessions/${session1}/acknowledge`,
      token: workerToken,
      storeId: t.storeA,
      body: {},
    });
    expect(res.status).toBe(403);
    expect((res.body.error as { message: string }).message).toContain('service.manage');
    apiErrorSchema.parse(res.body);
  });

  it('full lifecycle: ack → arrive → start → extend → complete with tech + room sync', async () => {
    const ack = await bossPost(`/v1/service-sessions/${session1}/acknowledge`);
    expect(ack.status).toBe(201);
    expect(data<{ status: string }>(ack)).toMatchObject({ status: 'ACKNOWLEDGED' });
    expect(
      (
        await db.query<{ status: string }>(`SELECT status FROM technicians WHERE id = $1`, [
          t.tech1,
        ])
      ).rows[0]!.status,
    ).toBe('GOING_TO_ROOM');

    const arrive = await bossPost(`/v1/service-sessions/${session1}/arrive`);
    expect(arrive.status).toBe(201);
    expect(
      (
        await db.query<{ status: string }>(`SELECT status FROM technicians WHERE id = $1`, [
          t.tech1,
        ])
      ).rows[0]!.status,
    ).toBe('WAITING_START');

    const start = await bossPost(`/v1/service-sessions/${session1}/start`);
    expect(start.status).toBe(201);
    expect(data<{ status: string }>(start)).toMatchObject({ status: 'STARTED' });
    const room = await db.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1`,
      [visit1Room],
    );
    expect(room.rows[0]!.operational_state).toBe('IN_SERVICE');
    expect(
      (
        await db.query<{ status: string }>(`SELECT status FROM technicians WHERE id = $1`, [
          t.tech1,
        ])
      ).rows[0]!.status,
    ).toBe('SERVING');

    const ext = await bossPost(`/v1/service-sessions/${session1}/extend`, {
      minutes: 30,
      priceDeltaCents: 5000,
    });
    expect(ext.status).toBe(201);
    const extD = data<{ durationMinutes: number }>(ext);
    expect(extD.durationMinutes).toBe(120);
    const extRow = await db.query<{ minutes: number; price_delta_cents: string }>(
      `SELECT minutes, price_delta_cents FROM service_extensions WHERE service_session_id = $1`,
      [session1],
    );
    expect(extRow.rows).toHaveLength(1);
    expect(extRow.rows[0]).toMatchObject({ minutes: 30 });

    const done = await bossPost(`/v1/service-sessions/${session1}/complete`);
    expect(done.status).toBe(201);
    expect(data<{ status: string }>(done)).toMatchObject({ status: 'COMPLETED' });

    const after = await db.query<{
      operational_state: string;
    }>(`SELECT operational_state FROM rooms WHERE id = $1`, [visit1Room]);
    expect(after.rows[0]!.operational_state).toBe('WAITING_CHECKOUT');

    const tech = await db.query<{ status: string }>(
      `SELECT status FROM technicians WHERE id = $1`,
      [t.tech1],
    );
    expect(tech.rows[0]!.status).toBe('AVAILABLE');
    const entry = await db.query<{ state: string }>(
      `SELECT state FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(entry.rows[0]!.state).toBe('ACTIVE');

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE store_id = $1`,
      [t.storeA],
    );
    const types = events.rows.map((e) => e.event_type);
    for (const want of [
      'service.started',
      'service.extended',
      'service.completed',
      'room.updated',
    ]) {
      expect(types, want).toContain(want);
    }
  });

  it('self-service: worker runs acknowledge/arrive on OWN session without service.manage; terminate denied statically', async () => {
    const create = await bossPost('/v1/service-sessions', {
      roomId: visit1Room,
      serviceVariantId: t.serviceVariantId2,
      technicianId: workerTechId,
      assignmentType: 'MANUAL',
    });
    expect(create.status).toBe(201);
    expect(data<{ status: string }>(create)).toMatchObject({ status: 'ASSIGNED' });
    const sid = data<{ sessionId: string }>(create).sessionId;

    const ack = await call({
      method: 'POST',
      url: `/v1/service-sessions/${sid}/acknowledge`,
      token: workerToken,
      storeId: t.storeA,
      body: {},
    });
    expect(ack.status).toBe(201);

    const arrive = await call({
      method: 'POST',
      url: `/v1/service-sessions/${sid}/arrive`,
      token: workerToken,
      storeId: t.storeA,
      body: {},
    });
    expect(arrive.status).toBe(201);

    // static route perm: role.employee lacks service.terminate even on own session
    const term = await call({
      method: 'POST',
      url: `/v1/service-sessions/${sid}/terminate`,
      token: workerToken,
      storeId: t.storeA,
      body: { reasonCode: 'GUEST_LEFT' },
    });
    expect(term.status).toBe(403);
    expect((term.body.error as { message: string }).message).toContain('service.terminate');

    // boss (service.terminate) terminates the ARRIVED session → technician released
    const bossTerm = await bossPost(`/v1/service-sessions/${sid}/terminate`, {
      reasonCode: 'GUEST_LEFT',
    });
    expect(bossTerm.status).toBe(201);
    expect(data<{ status: string }>(bossTerm)).toMatchObject({ status: 'TERMINATED' });
    const wt = await db.query<{ status: string }>(`SELECT status FROM technicians WHERE id = $1`, [
      workerTechId,
    ]);
    expect(wt.rows[0]!.status).toBe('AVAILABLE');
  });

  it('change-technician swaps (old released + requeued, new assigned, workflow recorded) + change-service re-snapshots price', async () => {
    // second visit/room so room state stays independent of the completed flow
    const open2 = await bossPost(`/v1/rooms/${t.roomClean2}/open`, {});
    expect(open2.status).toBe(201);
    visit2Room = t.roomClean2;
    expect((await bossPost(`/v1/technicians/${t.tech2}/clock-in`)).status).toBe(201);

    const create = await bossPost('/v1/service-sessions', {
      roomId: visit2Room,
      serviceVariantId: t.serviceVariantId2,
      technicianId: t.tech1,
    });
    session3 = data<{ sessionId: string }>(create).sessionId;
    expect(data<{ status: string }>(create)).toMatchObject({ status: 'ASSIGNED' });

    const swap = await bossPost(`/v1/service-sessions/${session3}/change-technician`, {
      technicianId: t.tech2,
      reasonCode: 'REQUESTED',
    });
    expect(swap.status).toBe(201);
    expect(data<{ technicianId: string }>(swap).technicianId).toBe(t.tech2);

    const [oldTech, newTech] = await Promise.all([
      db.query<{ status: string }>(`SELECT status FROM technicians WHERE id = $1`, [t.tech1]),
      db.query<{ status: string }>(`SELECT status FROM technicians WHERE id = $1`, [t.tech2]),
    ]);
    expect(oldTech.rows[0]!.status).toBe('AVAILABLE');
    expect(newTech.rows[0]!.status).toBe('ASSIGNED');
    const requests = await db.query<{ status: string }>(
      `SELECT status FROM technician_change_requests WHERE session_id = $1`,
      [session3],
    );
    expect(requests.rows).toEqual([{ status: 'APPROVED' }]);

    const swap2 = await bossPost(`/v1/service-sessions/${session3}/change-service`, {
      serviceVariantId: t.serviceVariantId,
    });
    expect(swap2.status).toBe(201);
    const sess = await db.query<{ price_cents: string; duration_minutes: number }>(
      `SELECT price_cents, duration_minutes FROM service_sessions WHERE id = $1`,
      [session3],
    );
    expect(sess.rows[0]).toMatchObject({ price_cents: '29800', duration_minutes: 90 });
  });

  it('start then terminate (exception): room reaches WAITING_CHECKOUT, technician released', async () => {
    expect((await bossPost(`/v1/service-sessions/${session3}/acknowledge`)).status).toBe(201);
    expect((await bossPost(`/v1/service-sessions/${session3}/arrive`)).status).toBe(201);
    const start = await bossPost(`/v1/service-sessions/${session3}/start`);
    expect(start.status).toBe(201);
    const roomIn = await db.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1`,
      [visit2Room],
    );
    expect(roomIn.rows[0]!.operational_state).toBe('IN_SERVICE');

    const term = await bossPost(`/v1/service-sessions/${session3}/terminate`, {
      reasonCode: 'EQUIPMENT_FAULT',
    });
    expect(term.status).toBe(201);
    expect(data<{ status: string }>(term)).toMatchObject({ status: 'TERMINATED' });

    const roomOut = await db.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1`,
      [visit2Room],
    );
    expect(roomOut.rows[0]!.operational_state).toBe('WAITING_CHECKOUT');
    const tech = await db.query<{ status: string }>(
      `SELECT status FROM technicians WHERE id = $1`,
      [t.tech2],
    );
    expect(tech.rows[0]!.status).toBe('AVAILABLE');
  });

  it('cross-store: store-B clerk gets 404 for store-A sessions and visits', async () => {
    const direct = await call({
      url: `/v1/service-sessions/${session1}`,
      token: clerkToken,
      storeId: t.storeB,
    });
    expect(direct.status).toBe(404);
    apiErrorSchema.parse(direct.body);

    const crossCreate = await call({
      method: 'POST',
      url: '/v1/service-sessions',
      token: clerkToken,
      storeId: t.storeB,
      body: { visitId: visit1Room, serviceVariantId: t.serviceVariantId },
    });
    expect(crossCreate.status).toBe(404);
  });

  it('GET /v1/service-sessions list: store-scoped + technician/today/active filters', async () => {
    const all = await call({
      url: '/v1/service-sessions',
      token: bossToken,
      storeId: t.storeA,
    });
    expect(all.status).toBe(200);
    apiSuccessSchema.parse(all.body);
    const items = (all.body.data as { items: Array<{ id: string }> }).items;
    expect(items.length).toBeGreaterThanOrEqual(4); // sessions 1,2,3 + worker session

    const byTech = await call({
      url: `/v1/service-sessions?technicianId=${t.tech1}`,
      token: bossToken,
      storeId: t.storeA,
    });
    const techItems = (byTech.body.data as { items: Array<{ id: string }> }).items;
    expect(techItems.map((x) => x.id)).toContain(session1);

    const today = await call({
      url: '/v1/service-sessions?today=1',
      token: bossToken,
      storeId: t.storeA,
    });
    expect((today.body.data as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(4);

    // session2 (DRAFT, never assigned) is the only non-terminal row left
    const active = await call({
      url: '/v1/service-sessions?activeOnly=1',
      token: bossToken,
      storeId: t.storeA,
    });
    const activeItems = (active.body.data as { items: Array<{ id: string }> }).items;
    expect(activeItems.map((x) => x.id)).toEqual([session2]);

    // cross-store scoping
    const other = await call({
      url: '/v1/service-sessions',
      token: clerkToken,
      storeId: t.storeB,
    });
    expect((other.body.data as { items: unknown[] }).items).toHaveLength(0);
  });

  it('append-only: service_session_events rejects UPDATE/DELETE (23001)', async () => {
    await expect(
      db.query(`UPDATE service_session_events SET event_type = 'X'`),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(db.query(`DELETE FROM service_session_events`)).rejects.toMatchObject({
      code: '23001',
    });
    const rows = await db.query(`SELECT 1 FROM service_session_events`);
    expect(rows.rows.length).toBeGreaterThan(0);

    const audit = await db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs
       WHERE action LIKE 'service.%' ORDER BY action`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'service.create',
        'service.assign',
        'service.acknowledge',
        'service.arrive',
        'service.start',
        'service.extend',
        'service.complete',
        'service.terminate',
        'service.change_technician',
        'service.change_service',
      ]),
    );
  });
});
