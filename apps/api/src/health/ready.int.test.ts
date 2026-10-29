import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator } from '@lanxu/db';
import { startPgHarness, type PgHarness } from '@lanxu/testkit';
import { apiErrorSchema, apiSuccessSchema } from '@lanxu/contracts';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { configureApi } from '../setup';

/**
 * Phase 01: /health/ready end-to-end semantics — pending migrations ⇒ 503,
 * migrations applied ⇒ 200, all against REAL PostgreSQL 18 (no fakes).
 */

describe('readiness against real PostgreSQL', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-ready-');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 4000,
        LOG_LEVEL: 'fatal',
        DATABASE_URL: harness.connectionString,
        JWT_SECRET: 't'.repeat(48),
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
    await harness?.stop();
  });

  it('DB reachable but migrations pending → 503 SERVICE_UNAVAILABLE (fail closed)', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(res.statusCode).toBe(503);
    const parsed = apiErrorSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('SERVICE_UNAVAILABLE');
      const checks = Object.fromEntries(
        (parsed.data.error.details ?? []).map((d) => [d.path, d.message]),
      );
      expect(checks.db).toBe('ok');
      expect(checks.migrations).toBe('pending');
    }
  });

  it('after migrate up → 200 ready envelope', async () => {
    const pool = createPool(harness.connectionString, { max: 2 });
    try {
      const applied = await new Migrator(pool).up();
      // disk-driven: a new migration must never silently pass/fail this gate
      const { readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const expected = readdirSync(join(process.cwd(), 'packages', 'db', 'migrations'))
        .filter((f: string) => f.endsWith('.up.sql'))
        .map((f: string) => f.replace(/\.up\.sql$/, ''))
        .sort();
      expect(applied).toEqual(expected);
    } finally {
      await pool.end();
    }

    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/health/ready',
        headers: { 'x-request-id': 'ready-after-migrate' },
      });
    expect(res.statusCode).toBe(200);
    const parsed = apiSuccessSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    const data = (
      JSON.parse(res.body) as { data: { status: string; checks: Record<string, string> } }
    ).data;
    expect(data.status).toBe('ready');
    expect(data.checks).toEqual({ db: 'ok', migrations: 'ok' });
    expect(res.headers['x-request-id']).toBe('ready-after-migrate');
  });
});
