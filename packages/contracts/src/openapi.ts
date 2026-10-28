import { z } from 'zod';
import { apiErrorSchema } from './errors';

/** OpenAPI 3.1.2 document assembled from zod schemas (ADR-0005). */

export const OPENAPI_VERSION = '3.1.2';

const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z
      .array(z.object({ path: z.string(), code: z.string(), message: z.string() }))
      .optional(),
  }),
});

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'LanXu StoreOS API',
      version: '0.1.0',
      description:
        '澜序 LanXu StoreOS V1 HTTP contract. Clients branch on error.code only. ' +
        'Source of truth: docs/product/lanxu-storeos-v1-master-spec.md §7.',
    },
    servers: [{ url: '/', description: 'current host' }],
    paths: {
      '/health/live': {
        get: {
          operationId: 'getHealthLive',
          summary: 'Liveness: process is alive',
          tags: ['health'],
          responses: {
            '200': {
              description: 'alive',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['data'],
                    properties: {
                      data: {
                        type: 'object',
                        required: ['status'],
                        properties: { status: { type: 'string', const: 'live' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/health/ready': {
        get: {
          operationId: 'getHealthReady',
          summary: 'Readiness: can actually serve traffic (DB reachable, migrations current)',
          tags: ['health'],
          responses: {
            '200': {
              description: 'ready',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '503': {
              description: 'not ready',
              content: { 'application/json': { schema: jsonSchemaOf(errorEnvelopeSchema) } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorEnvelope: jsonSchemaOf(apiErrorSchema),
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
