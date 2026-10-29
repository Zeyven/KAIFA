import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { startPgHarness, seedTenant, type PgHarness, type TenantFixture } from '@lanxu/testkit';
import { apiSuccessSchema } from '@lanxu/contracts';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { configureApi } from '../setup';

/**
 * Phase 05 integration — scheduling over real HTTP + real PG: queue ordering,
 * explainable recommend, atomic §6.4 assign (concurrent double-assign ⇒ exactly
 * one winner), skill/locked/queued hard gates, skip/compensate/reorder queue ops
 * with permission split (assign vs assign.force), audit + queue events evidence.
 */

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
}

describe('scheduling (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let t: TenantFixture;
  let bossToken = '';
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

  const clockIn = (techId: string, token: string) =>
    call({
      method: 'POST',
      url: `/v1/technicians/${techId}/clock-in`,
      token,
      storeId: t.storeA,
      body: {},
    });

  function queueItems(body: Record<string, unknown>): Array<{
    id: string;
    technician_id: string;
    position_key: string;
    priority_delta: number;
    state: string;
    technician_status: string;
  }> {
    return (body.data as { items: Array<never> }).items;
  }

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-sched-');
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
        JWT_SECRET: 's'.repeat(48),
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('queue starts empty', async () => {
    const res = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    expect(res.status).toBe(200);
    expect((res.body.data as { items: unknown[] }).items).toHaveLength(0);
    const data = res.body.data as { weights: Record<string, number>; policy: string };
    expect(data.weights.queuePosition).toBe(1000);
    expect(data.policy).toContain('BUSINESS POLICY');
  });

  it('clock-in two technicians → queue has both in position order', async () => {
    const a = await clockIn(t.tech1, bossToken);
    const b = await clockIn(t.tech2, bossToken);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const res = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    const items = queueItems(res.body);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.technician_id)).toEqual([t.tech1, t.tech2]);
    expect(items.every((i) => i.state === 'ACTIVE')).toBe(true);
    expect(items.every((i) => i.technician_status === 'AVAILABLE')).toBe(true);
  });

  it('recommend selects queue head with §6.5 explainability + echoed weights', async () => {
    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/recommend',
      token: bossToken,
      storeId: t.storeA,
      body: { serviceVariantId: t.serviceVariantId },
    });
    expect(res.status).toBe(201);
    apiSuccessSchema.parse(res.body);
    const data = res.body.data as {
      selected?: {
        technicianId: string;
        queuePosition: number;
        idleMinutes: number;
        score: number;
      };
      excluded: Array<{ technicianNo: string; reason: string }>;
      weights: Record<string, number>;
    };
    expect(data.selected?.technicianId).toBe(t.tech1);
    expect(data.selected?.queuePosition).toBe(1);
    expect(typeof data.selected?.score).toBe('number');
    // tech2 only skilled for V60 → excluded under V90 with machine-readable reason
    expect(data.excluded).toEqual([
      { technicianId: t.tech2, technicianNo: expect.any(String), reason: 'SKILL_MISSING' },
    ]);
    expect(data.weights.queuePosition).toBe(1000);
  });

  it('recommend excludes locked technician (hard constraint, machine-readable reason)', async () => {
    const lock = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech2}/lock`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(lock.status).toBe(201);

    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/recommend',
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    const data = res.body.data as {
      selected?: { technicianId: string };
      excluded: Array<{ technicianId: string; reason: string }>;
    };

    // restore state FIRST — later tests depend on tech2 being unlocked
    const unlock = await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech2}/unlock`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect(unlock.status).toBe(201);

    expect(data.selected?.technicianId).toBe(t.tech1);
    expect(data.excluded.find((x) => x.technicianId === t.tech2)?.reason).toBe('LOCKED');
  });

  it('skip moves entry to queue end → recommend flips to the new head', async () => {
    const queue = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    const first = queueItems(queue.body).find((i) => i.technician_id === t.tech1)!;

    const skip = await call({
      method: 'POST',
      url: '/v1/scheduling/skip',
      token: bossToken,
      storeId: t.storeA,
      body: { queueEntryId: first.id },
    });
    expect(skip.status).toBe(201);

    const after = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    expect(queueItems(after.body).map((i) => i.technician_id)).toEqual([t.tech2, t.tech1]);

    const rec = await call({
      method: 'POST',
      url: '/v1/scheduling/recommend',
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    expect((rec.body.data as { selected?: { technicianId: string } }).selected?.technicianId).toBe(
      t.tech2,
    );
  });

  it('reorder puts the skipped technician back at the front (explicit numeric keys)', async () => {
    const queue = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    const items = queueItems(queue.body);
    const tech1Entry = items.find((i) => i.technician_id === t.tech1)!;

    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/reorder',
      token: bossToken,
      storeId: t.storeA,
      body: { items: [{ entryId: tech1Entry.id, positionKey: 500 }] },
    });
    expect(res.status).toBe(201);
    const after = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    expect(queueItems(after.body).map((i) => i.technician_id)).toEqual([t.tech1, t.tech2]);
  });

  it('compensate raises priority_delta (force perm) and shows in effective order', async () => {
    const queue = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    const tech2Entry = queueItems(queue.body).find((i) => i.technician_id === t.tech2)!;

    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/compensate',
      token: bossToken,
      storeId: t.storeA,
      body: { queueEntryId: tech2Entry.id, delta: 2 },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ priorityDelta: 2 });

    // aide (frontdesk@A) holds schedule.assign but NOT schedule.assign.force → 403
    const aideTok = await login(t.aideUsername);
    const denied = await call({
      method: 'POST',
      url: '/v1/scheduling/compensate',
      token: aideTok,
      storeId: t.storeA,
      body: { queueEntryId: tech2Entry.id, delta: 1 },
    });
    expect(denied.status).toBe(403);
    expect((denied.body.error as { message: string }).message).toContain('schedule.assign.force');
  });

  it('assign hard gates: missing skill → 422 TECHNICIAN_NOT_AVAILABLE; locked → TECHNICIAN_LOCKED', async () => {
    // tech2 is skilled only for V60 — assign under V90 → missing skill
    const noSkill = await call({
      method: 'POST',
      url: '/v1/scheduling/assign',
      token: bossToken,
      storeId: t.storeA,
      body: { technicianId: t.tech2, serviceVariantId: t.serviceVariantId },
    });
    expect(noSkill.status).toBe(422);
    expect((noSkill.body.error as { code: string }).code).toBe('TECHNICIAN_NOT_AVAILABLE');

    await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech2}/lock`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
    const locked = await call({
      method: 'POST',
      url: '/v1/scheduling/assign',
      token: bossToken,
      storeId: t.storeA,
      body: { technicianId: t.tech2, serviceVariantId: t.serviceVariantId },
    });
    expect(locked.status).toBe(422);
    expect((locked.body.error as { code: string }).code).toBe('TECHNICIAN_LOCKED');
    await call({
      method: 'POST',
      url: `/v1/technicians/${t.tech2}/unlock`,
      token: bossToken,
      storeId: t.storeA,
      body: {},
    });
  });

  it('CONCURRENT double-assign of one technician → exactly one winner (§6.4)', async () => {
    const body = JSON.stringify({
      technicianId: t.tech1,
      serviceVariantId: t.serviceVariantId,
    });
    const headers = {
      authorization: `Bearer ${bossToken}`,
      'x-store-id': t.storeA,
      'content-type': 'application/json',
    };
    const inst = app.getHttpAdapter().getInstance();
    const [r1, r2] = await Promise.all([
      inst.inject({ method: 'POST', url: '/v1/scheduling/assign', headers, payload: body }),
      inst.inject({ method: 'POST', url: '/v1/scheduling/assign', headers, payload: body }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 422]);

    const tech = await db.query<{ status: string }>(
      `SELECT status FROM technicians WHERE id = $1`,
      [t.tech1],
    );
    expect(tech.rows[0]!.status).toBe('ASSIGNED');
    const entries = await db.query<{ state: string }>(
      `SELECT state FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    expect(entries.rows[0]!.state).toBe('ASSIGNED');
  });

  it('assign success: tech2 → ASSIGNED with history + queue event + audit + events', async () => {
    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/assign',
      token: bossToken,
      storeId: t.storeA,
      body: { technicianId: t.tech2, serviceVariantId: t.serviceVariantId2 },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'ASSIGNED' });

    const hist = await db.query<{ reason_code: string }>(
      `SELECT reason_code FROM technician_status_history WHERE technician_id = $1`,
      [t.tech2],
    );
    expect(hist.rows.at(-1)).toMatchObject({ reason_code: 'ASSIGN' });

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'technician.assign'`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE store_id = $1`,
      [t.storeA],
    );
    const types = events.rows.map((e) => e.event_type);
    expect(types.filter((x) => x === 'technician.status_changed').length).toBeGreaterThanOrEqual(2);
    expect(types.filter((x) => x === 'technician.queue_changed').length).toBeGreaterThanOrEqual(3);
  });

  it('assign a technician with no queue entry → 422 (queue-first workflow)', async () => {
    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/assign',
      token: bossToken,
      storeId: t.storeA,
      body: { technicianId: t.tech4 },
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { code: string; message: string }).code).toBe(
      'TECHNICIAN_NOT_AVAILABLE',
    );
    expect((res.body.error as { message: string }).message).toContain('queue entry');
  });

  it('queue ops reject non-ACTIVE entries (assigned rows are not reorderable)', async () => {
    const entries = await db.query<{ id: string }>(
      `SELECT id FROM technician_queue_entries WHERE technician_id = $1`,
      [t.tech1],
    );
    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/reorder',
      token: bossToken,
      storeId: t.storeA,
      body: { items: [{ entryId: entries.rows[0]!.id, positionKey: 1 }] },
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { code: string }).code).toBe('INVALID_STATE_TRANSITION');
  });

  it('stale expectedVersion on skip → 409', async () => {
    const queue = await call({ url: '/v1/scheduling/queue', token: bossToken, storeId: t.storeA });
    const entries = queueItems(queue.body);
    const target = entries.find((i) => i.state === 'ACTIVE');
    if (!target) {
      // all entries assigned — create a fresh queued technician via re-clock of tech3
      const aideLogin = await login(t.aideUsername);
      await call({
        method: 'POST',
        url: `/v1/technicians/${t.tech3}/clock-in`,
        token: aideLogin,
        storeId: t.storeA,
        body: {},
      });
      const fresh = await call({
        url: '/v1/scheduling/queue',
        token: bossToken,
        storeId: t.storeA,
      });
      const freshItems = queueItems(fresh.body);
      expect(freshItems.length).toBeGreaterThan(0);
      const res = await call({
        method: 'POST',
        url: '/v1/scheduling/skip',
        token: bossToken,
        storeId: t.storeA,
        body: { queueEntryId: freshItems.at(-1)!.id, expectedVersion: 99 },
      });
      expect(res.status).toBe(409);
      return;
    }
    const res = await call({
      method: 'POST',
      url: '/v1/scheduling/skip',
      token: bossToken,
      storeId: t.storeA,
      body: { queueEntryId: target.id, expectedVersion: 99 },
    });
    expect(res.status).toBe(409);
  });

  it('cross-store: store-B clerk gets an empty queue, never store-A entries', async () => {
    const res = await call({ url: '/v1/scheduling/queue', token: clerkToken, storeId: t.storeB });
    expect(res.status).toBe(200);
    expect((res.body.data as { items: unknown[] }).items).toHaveLength(0);
    apiSuccessSchema.parse(res.body);
  });
});
