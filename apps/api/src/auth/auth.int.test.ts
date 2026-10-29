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
 * Phase 02 integration — real PostgreSQL, full HTTP pipeline (no fakes):
 * login success/failure semantics, rate limiting, JWT tamper/expiry,
 * store-scope authorization, permission denial, IDOR cross-store 404,
 * and append-only security-event evidence.
 */

const JWT_SECRET = 't'.repeat(48);

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

describe('auth + object-level authorization (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let tenant: TenantFixture;

  async function call(opts: InjectOpts): Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: Record<string, unknown>;
  }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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
    return {
      status: res.statusCode,
      headers: res.headers as Record<string, unknown>,
      body: JSON.parse(res.body) as Record<string, unknown>,
    };
  }

  async function login(username: string, password: string, orgCode = tenant.orgCode) {
    return call({
      method: 'POST',
      url: '/v1/auth/login',
      body: { orgCode, username, password },
    });
  }

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-auth-');
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
        JWT_SECRET,
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  let bossToken = '';

  it('valid credentials → 200 with token + store list (success envelope)', async () => {
    const res = await login(tenant.bossUsername, tenant.password);
    expect(res.status).toBe(200);
    const parsed = apiSuccessSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const data = res.body.data as { token: string; stores: Array<{ code: string }> };
    expect(typeof data.token).toBe('string');
    expect(data.stores.map((s) => s.code)).toContain('S01');
    bossToken = data.token;
    expect(bossToken.length).toBeGreaterThan(50);
  });

  it('wrong password → 401 generic envelope (identical to unknown user)', async () => {
    // uses the clerk key so the boss key stays untouched for the rate-limit test
    const wrong = await login(tenant.clerkUsername, 'not-the-password');
    expect(wrong.status).toBe(401);
    const unknown = await login('ghost_user_does_not_exist', tenant.password);
    expect(unknown.status).toBe(401);
    expect((wrong.body.error as { code: string; message: string }).code).toBe('UNAUTHENTICATED');
    // anti-enumeration: same code AND same message for unknown vs bad password
    expect((wrong.body.error as { message: string }).message).toBe(
      (unknown.body.error as { message: string }).message,
    );
    expect(apiErrorSchema.safeParse(wrong.body).success).toBe(true);
  });

  it('missing / tampered / expired tokens → 401 UNAUTHENTICATED', async () => {
    const missing = await call({ url: '/v1/auth/me' });
    expect(missing.status).toBe(401);
    expect((missing.body.error as { code: string }).code).toBe('UNAUTHENTICATED');

    const tampered = await call({ url: '/v1/auth/me', token: `${bossToken}x` });
    expect(tampered.status).toBe(401);

    // forge an EXPIRED token with the same secret (kid = server key) — verifies
    // exp enforcement, not just signature validity
    const jose = await import('jose');
    const key = new TextEncoder().encode(JWT_SECRET);
    const expired = await new jose.SignJWT({ orgId: tenant.orgId, username: tenant.bossUsername })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(tenant.bossUserId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    const res = await call({ url: '/v1/auth/me', token: expired });
    expect(res.status).toBe(401);
  });

  it('valid token without X-Store-Id on store route → 403 UNAUTHORIZED_SCOPE', async () => {
    const res = await call({ url: '/v1/rooms', token: bossToken });
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('UNAUTHORIZED_SCOPE');
  });

  it('X-Store-Id outside principal org / without employment → 403 UNAUTHORIZED_SCOPE', async () => {
    // boss is employed only at store A — store B request must be rejected
    const res = await call({ url: '/v1/rooms', token: bossToken, storeId: tenant.storeB });
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('UNAUTHORIZED_SCOPE');

    // foreign store id (random uuid) — also scope denial, never 500
    const foreign = await call({
      url: '/v1/rooms',
      token: bossToken,
      storeId: '01990000-0000-7000-8000-000000000001',
    });
    expect(foreign.status).toBe(403);
  });

  it("IDOR: store B clerk cannot read store A's room → 404 (object-level check)", async () => {
    const clerkLogin = await login(tenant.clerkUsername, tenant.password);
    expect(clerkLogin.status).toBe(200);
    const clerkToken = (clerkLogin.body.data as { token: string }).token;

    // legitimate read within own store works…
    const own = await call({
      url: `/v1/rooms/${tenant.roomOtherStore}`,
      token: clerkToken,
      storeId: tenant.storeB,
    });
    expect(own.status).toBe(200);

    // …but pointing the SAME token+scope at store A's room is 404, not 403-leak
    const crossWithB = await call({
      url: `/v1/rooms/${tenant.roomClean1}`,
      token: clerkToken,
      storeId: tenant.storeB,
    });
    expect(crossWithB.status).toBe(404);

    // and clerk claiming store A scope is denied before object lookup
    const crossWithA = await call({
      url: `/v1/rooms/${tenant.roomClean1}`,
      token: clerkToken,
      storeId: tenant.storeA,
    });
    expect(crossWithA.status).toBe(403);
    expect((crossWithA.body.error as { code: string }).code).toBe('UNAUTHORIZED_SCOPE');
  });

  it('missing permission → 403 FORBIDDEN with missing code listed', async () => {
    const clerkLogin = await login(tenant.clerkUsername, tenant.password);
    const clerkToken = (clerkLogin.body.data as { token: string }).token;
    // frontdesk (clerk role) has no room.disable grant
    const res = await call({
      method: 'POST',
      url: `/v1/rooms/${tenant.roomOtherStore}/disable`,
      token: clerkToken,
      storeId: tenant.storeB,
      body: {},
    });
    expect(res.status).toBe(403);
    const err = res.body.error as { code: string; message: string };
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toContain('room.disable');
  });

  it('login rate limit: 5 failures/60s → 6th attempt 429 even with good password', async () => {
    for (let i = 0; i < 5; i += 1) {
      const fail = await login(tenant.bossUsername, 'definitely-wrong');
      expect(fail.status).toBe(401);
    }
    const blocked = await login(tenant.bossUsername, tenant.password);
    expect(blocked.status).toBe(429);
    expect((blocked.body.error as { code: string }).code).toBe('RATE_LIMITED');
    apiErrorSchema.parse(blocked.body);
  });

  it('security evidence: failed logins and denials land in security_events', async () => {
    const { rows } = await db.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*)::text AS n FROM security_events
       WHERE organization_id = $1 GROUP BY event_type ORDER BY event_type`,
      [tenant.orgId],
    );
    const byType = Object.fromEntries(rows.map((r) => [r.event_type, Number(r.n)]));
    expect(byType.LOGIN_FAILED ?? 0).toBeGreaterThanOrEqual(5);
    expect(byType.LOGIN_SUCCESS ?? 0).toBeGreaterThanOrEqual(1);
    expect(byType.AUTHZ_DENIED ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('/v1/auth/me without store bootstrap → identity + empty permissions', async () => {
    const res = await call({ url: '/v1/auth/me', token: bossToken });
    expect(res.status).toBe(200);
    const data = res.body.data as { id: string; permissions: string[] | null; stores: unknown[] };
    expect(data.id).toBe(tenant.bossUserId);
    expect(data.permissions).toBeNull();
    expect(data.stores.length).toBeGreaterThanOrEqual(1);

    const withStore = await call({
      url: '/v1/auth/me',
      token: bossToken,
      storeId: tenant.storeA,
    });
    expect(withStore.status).toBe(200);
    const perms = (withStore.body.data as { permissions: string[] }).permissions;
    expect(perms).toContain('room.open');
    expect(perms).toContain('room.disable');
  });
});
