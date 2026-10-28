import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@lanxu/observability';

/**
 * Bridges Nest's internal lifecycle logging into the structured pino root
 * logger so every line carries `service` + consistent shape (spec §16.3).
 */
export class StructuredNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
