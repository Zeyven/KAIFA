import pino from 'pino';
import type { Logger } from 'pino';
import { PINO_REDACT_PATHS } from './redact';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  service: string;
}

/**
 * Structured root logger (spec §16.3). Every log line carries `service`;
 * request-scoped children add `requestId`/`store`/`actor`/`action` via
 * `child()`. Sensitive fields are redacted (pino paths belt + deep redactor
 * used by callers for payload objects).
 */
export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  });
}

/** Field names allowed on a request log line (allowlist discipline). */
export const REQUEST_LOG_FIELDS = [
  'requestId',
  'traceId',
  'method',
  'url',
  'status',
  'latencyMs',
  'storeId',
  'orgId',
  'actorId',
  'actorType',
  'action',
  'resource',
  'result',
  'errorCode',
] as const;
