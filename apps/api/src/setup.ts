import type { INestApplication } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '@lanxu/observability';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

/**
 * Single place wiring cross-cutting HTTP behavior, used by BOTH production
 * bootstrap and tests so they cannot drift: error envelope filter + per-request
 * id header echo + structured access log.
 *
 * Hooks are registered before init/listen (fastify locks plugins on ready).
 */
export function configureApi(app: INestApplication, logger?: Logger): void {
  app.useGlobalFilters(new HttpExceptionFilter(logger));

  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;

  fastify.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', String(req.id));
  });

  if (logger) {
    fastify.addHook('onResponse', async (req, reply) => {
      logger.info(
        {
          requestId: String(req.id),
          method: req.method,
          url: req.url,
          status: reply.statusCode,
          latencyMs: Math.round(reply.elapsedTime),
          result: reply.statusCode < 400 ? 'ok' : 'error',
        },
        'request',
      );
    });
  }
}
