import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';
import { apiErrorSchema } from '@lanxu/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ApiError } from '@lanxu/contracts';
import { configureApi } from '../setup';

/** Deterministic env for tests: no DATABASE_URL → readiness honestly fails. */
const TEST_ENV = {
  NODE_ENV: 'test' as const,
  PORT: 4000,
  LOG_LEVEL: 'error' as const,
  JWT_SECRET: 't'.repeat(48),
  JWT_ACCESS_TTL_SECONDS: 3600,
  PAYMENT_PROVIDER: 'fake' as const,
};

async function createApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(TEST_ENV)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(createFastifyOptions()),
  );
  configureApi(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('health endpoints (Phase 00 slice)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live → 200 envelope + echoes X-Request-Id', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'req-test-001' },
      });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-test-001');
    expect(JSON.parse(res.body)).toEqual({ data: { status: 'live' } });
  });

  it('generates a UUIDv7 request id when none supplied', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/health/live',
    });
    const id = String(res.headers['x-request-id']);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('GET /health/ready without DATABASE_URL → 503 error envelope (fail closed)', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/health/ready',
        headers: { 'x-request-id': 'req-test-002' },
      });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as unknown;
    const parsed = apiErrorSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(parsed.data.error.requestId).toBe('req-test-002');
      expect(parsed.data.error.details?.[0]?.path).toBe('db');
    }
  });

  it('unknown route → 404 NOT_FOUND envelope', async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('ZodValidationPipe', () => {
  const schema = z.object({ amountCents: z.int().nonnegative(), note: z.string().max(200) });

  it('accepts valid input and returns parsed data', () => {
    const pipe = new ZodValidationPipe(schema, 'body');
    expect(pipe.transform({ amountCents: 39800, note: 'x' })).toEqual({
      amountCents: 39800,
      note: 'x',
    });
  });

  it('rejects invalid input with VALIDATION_FAILED + per-path details', () => {
    const pipe = new ZodValidationPipe(schema, 'body');
    try {
      pipe.transform({ amountCents: -1, note: 42 });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('VALIDATION_FAILED');
      expect(apiErr.status).toBe(400);
      expect(apiErr.details?.map((d) => d.path)).toEqual(
        expect.arrayContaining(['amountCents', 'note']),
      );
    }
  });
});
