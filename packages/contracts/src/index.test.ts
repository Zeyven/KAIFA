import { describe, expect, it } from 'vitest';
import {
  ApiError,
  apiErrorSchema,
  buildOpenApiDocument,
  ERROR_CODES,
  OPENAPI_VERSION,
  statusForErrorCode,
} from './index';

describe('error envelope contract', () => {
  it('validates a well-formed error body', () => {
    const parsed = apiErrorSchema.safeParse({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Database is not reachable.',
        requestId: '0192f000-0000-7000-8000-000000000001',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown error codes (clients may only rely on registry codes)', () => {
    const parsed = apiErrorSchema.safeParse({
      error: { code: 'WEIRD_NEW_CODE', message: 'x', requestId: 'r' },
    });
    expect(parsed.success).toBe(false);
  });

  it('maps every code to a spec-legal HTTP status', () => {
    for (const code of ERROR_CODES) {
      const status = statusForErrorCode(code);
      expect([400, 401, 403, 404, 409, 422, 429, 500, 503]).toContain(status);
    }
  });

  it('ApiError carries code + status from the registry', () => {
    const err = new ApiError('INVALID_STATE_TRANSITION', 'nope');
    expect(err.status).toBe(422);
    expect(err.code).toBe('INVALID_STATE_TRANSITION');
    expect(
      apiErrorSchema.safeParse({ error: { code: err.code, message: err.message, requestId: 'x' } })
        .success,
    ).toBe(true);
  });
});

describe('OpenAPI 3.1 document', () => {
  it('emits a structurally valid 3.1.2 document with health paths and error component', () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe(OPENAPI_VERSION);
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    const paths = doc.paths as Record<string, unknown>;
    expect(Object.keys(paths)).toEqual(expect.arrayContaining(['/health/live', '/health/ready']));
    const components = doc.components as { schemas: Record<string, unknown> };
    expect(components.schemas.ErrorEnvelope).toBeTruthy();
    // OAS 3.1 embeds JSON Schema draft 2020-12 → $schema allowed/expected on schemas
    expect(JSON.stringify(doc)).not.toContain('undefined');
  });
});
