import type { FastifyServerOptions } from 'fastify';
import { newUuidv7 } from '@lanxu/domain';

/**
 * Fastify base options shared by production bootstrap and tests so both paths
 * behave identically: request ids are UUIDv7 (or a sanitized inbound
 * X-Request-Id), our own structured request logging replaces fastify's.
 */
export const MAX_REQUEST_ID_LEN = 128;

export function sanitizeRequestId(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (value.length === 0 || value.length > MAX_REQUEST_ID_LEN) return null;
  // printable ASCII only — header injection defense
  return /^[\x20-\x7e]+$/.test(value) ? value : null;
}

export function createFastifyOptions(): FastifyServerOptions {
  return {
    // fastify's own logger is off — we emit structured access logs ourselves
    // in configureApi() (onResponse hook) to keep one log pipeline.
    logger: false,
    genReqId(req) {
      return sanitizeRequestId(req.headers['x-request-id']) ?? newUuidv7();
    },
  };
}
