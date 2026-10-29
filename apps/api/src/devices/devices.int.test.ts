/**
 * Phase 09 — device enrollment / binding / heartbeat (spec §4.8 devices,
 * §10.2 unbound-code console flow, §10.4 backend-never-trusts-client-roomId).
 * Real PostgreSQL (pg-harness); no mocks.
 */
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

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  orgCode?: string;
  deviceCode?: string;
  body?: unknown;
  ip?: string;
}

describe('devices: enrollment/binding/heartbeat (integration)', () => {
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
    if (opts.orgCode) headers['x-org-code'] = opts.orgCode;
    if (opts.deviceCode) headers['x-device-code'] = opts.deviceCode;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: opts.method ?? 'GET',
        url: opts.url,
        headers,
        remoteAddress: opts.ip ?? '127.0.0.1',
        ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
      });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
  }

  async function login(
    username: string,
    orgCode = t.orgCode,
    password = t.password,
  ): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/v1/auth/login',
      body: { orgCode, username, password },
    });
    expect(res.status).toBe(200);
    return (res.body.data as { token: string }).token;
  }

  function data<T>(res: { body: Record<string, unknown> }): T {
    return res.body.data as T;
  }

  async function enrollOne(
    ip = '127.0.0.1',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return call({
      method: 'POST',
      url: '/v1/devices/enroll',
      orgCode: t.orgCode,
      body: { platform: 'android-kiosk', appVersion: '0.9.0' },
      ip,
    });
  }

  const boundDevice = async (): Promise<{ id: string; device_code: string }> => {
    const res = await call({ url: '/v1/devices', token: bossToken, storeId: t.storeA });
    const items = data<{ items: Array<{ id: string; device_code: string; status: string }> }>(
      res,
    ).items;
    const d = items.find((x) => x.status === 'ACTIVE')!;
    expect(d).toBeDefined();
    return d;
  };

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-dev-');
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('enroll: requires org code, resolves org, returns §10.2 device code + audit', async () => {
    const missing = await call({ method: 'POST', url: '/v1/devices/enroll', body: {} });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');

    const badOrg = await call({
      method: 'POST',
      url: '/v1/devices/enroll',
      orgCode: 'NOPE99',
      body: {},
    });
    expect(badOrg.status).toBe(404);

    const ok = await enrollOne();
    expect(ok.status).toBe(201);
    apiSuccessSchema.parse(ok.body);
    const en = data<{ id: string; deviceCode: string; status: string }>(ok);
    expect(en.status).toBe('PENDING');
    expect(en.deviceCode).toMatch(/^LX-R-[0-9A-Z]{5}$/);
    const { rows } = await db.query(
      `SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'device.enrolled'`,
      [en.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('list: org-scoped; PENDING visible to own org, never cross-org (object-level)', async () => {
    // clerk has device.read (0005) — list at own store
    const list = await call({ url: '/v1/devices', token: clerkToken, storeId: t.storeB });
    expect(list.status).toBe(200);
    const items = data<{ items: Array<{ status: string }> }>(list).items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    // another tenant's store sees zero devices even with a valid store header
    const other = await seedTenant(db);
    const otherBoss = await login(other.bossUsername, other.orgCode, other.password);
    const cross = await call({ url: '/v1/devices', token: otherBoss, storeId: other.storeA });
    expect(cross.status).toBe(200);
    expect(data<{ items: unknown[] }>(cross).items).toHaveLength(0);
  });

  it('bind: server cross-checks org/store/room; one ACTIVE device per room (409)', async () => {
    const en1 = await enrollOne();
    const en2 = await enrollOne();
    const dev1 = data<{ id: string }>(en1).id;
    const dev2 = data<{ id: string }>(en2).id;

    const noPerm = await call({
      method: 'POST',
      url: `/v1/devices/${dev1}/bind`,
      token: clerkToken,
      storeId: t.storeA,
      body: { storeId: t.storeA, roomId: t.roomClean1 },
    });
    expect(noPerm.status).toBe(403);

    // store A + room of store B → rejected at scope (client ids untrusted, §11)
    const cross = await call({
      method: 'POST',
      url: `/v1/devices/${dev1}/bind`,
      token: bossToken,
      storeId: t.storeA,
      body: { storeId: t.storeA, roomId: t.roomOtherStore },
    });
    expect(cross.status).toBe(403);
    expect((cross.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED_SCOPE');

    const ok = await call({
      method: 'POST',
      url: `/v1/devices/${dev1}/bind`,
      token: bossToken,
      storeId: t.storeA,
      body: { storeId: t.storeA, roomId: t.roomClean1 },
    });
    expect(ok.status).toBe(201);
    const bound = data<{ status: string; room_id: string }>(ok);
    expect(bound.status).toBe('ACTIVE');
    expect(bound.room_id).toBe(t.roomClean1);
    const { rows: audit } = await db.query(
      `SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'device.bound'`,
      [dev1],
    );
    expect(audit).toHaveLength(1);

    const clash = await call({
      method: 'POST',
      url: `/v1/devices/${dev2}/bind`,
      token: bossToken,
      storeId: t.storeA,
      body: { storeId: t.storeA, roomId: t.roomClean1 },
    });
    expect(clash.status).toBe(409);
    expect((clash.body as { error: { code: string } }).error.code).toBe(
      'ROOM_BOUND_TO_OTHER_DEVICE',
    );
  });

  it('heartbeat: binding via device code, bumps last_seen, unknown → 404 + security event', async () => {
    const dev = await boundDevice();
    const hb = await call({ url: '/v1/devices/heartbeat', deviceCode: dev.device_code });
    expect(hb.status).toBe(200);
    const beat = data<{ bound: boolean; roomId: string; roomCode: string }>(hb);
    expect(beat.bound).toBe(true);
    expect(beat.roomId).toBe(t.roomClean1);
    expect(beat.roomCode).toBe('R101');

    const unknown = await call({ url: '/v1/devices/heartbeat', deviceCode: 'LX-R-ZZZZZ' });
    expect(unknown.status).toBe(404);
    const { rows: sec } = await db.query(
      `SELECT 1 FROM security_events WHERE event_type = 'DEVICE_HEARTBEAT_UNKNOWN'`,
    );
    expect(sec.length).toBeGreaterThanOrEqual(1);
  });

  it('lifecycle: unbind → PENDING; disable → 403; revoke terminal', async () => {
    const dev = await boundDevice();

    const un = await call({
      method: 'POST',
      url: `/v1/devices/${dev.id}/unbind`,
      token: bossToken,
      storeId: t.storeA,
    });
    expect(un.status).toBe(201);
    expect(data<{ status: string }>(un).status).toBe('PENDING');
    const hb2 = await call({ url: '/v1/devices/heartbeat', deviceCode: dev.device_code });
    expect(data<{ bound: boolean }>(hb2).bound).toBe(false);

    const dis = await call({
      method: 'POST',
      url: `/v1/devices/${dev.id}/disable`,
      token: bossToken,
      storeId: t.storeA,
    });
    expect(dis.status).toBe(201);
    const hb3 = await call({ url: '/v1/devices/heartbeat', deviceCode: dev.device_code });
    expect(hb3.status).toBe(403);
    expect((hb3.body as { error: { code: string } }).error.code).toBe('DEVICE_DISABLED');

    const rev = await call({
      method: 'POST',
      url: `/v1/devices/${dev.id}/revoke`,
      token: bossToken,
      storeId: t.storeA,
    });
    expect(rev.status).toBe(201);
    const again = await call({
      method: 'POST',
      url: `/v1/devices/${dev.id}/revoke`,
      token: bossToken,
      storeId: t.storeA,
    });
    expect(again.status).toBe(422);
    const bindRevoked = await call({
      method: 'POST',
      url: `/v1/devices/${dev.id}/bind`,
      token: bossToken,
      storeId: t.storeA,
      body: { storeId: t.storeA, roomId: t.roomClean2 },
    });
    expect(bindRevoked.status).toBe(422);
    expect((bindRevoked.body as { error: { code: string } }).error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('enroll: per-IP rate limit trips inside the window (429 RATE_LIMITED)', async () => {
    // fresh key: exactly 10 allowed per window, then RATE_LIMITED
    let limited = false;
    for (let i = 0; i < 13 && !limited; i += 1) {
      const res = await enrollOne('10.9.9.9');
      if (res.status === 429) limited = true;
      else expect(res.status).toBe(201);
    }
    expect(limited).toBe(true);
    const { rows } = await db.query(
      `SELECT 1 FROM security_events WHERE event_type = 'DEVICE_ENROLL_RATE_LIMITED'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
