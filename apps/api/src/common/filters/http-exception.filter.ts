import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';
import { ApiError, type ErrorCode } from '@lanxu/contracts';
import { MachineError } from '@lanxu/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@lanxu/observability';

/**
 * Renders every error into the frozen wire envelope (spec §7.1):
 *   { "error": { "code", "message", "requestId"[, "details"] } }
 * Clients branch on `code`. Stack traces and internals never leave the process.
 */

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  422: 'INVALID_STATE_TRANSITION',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

function codeForStatus(status: number): ErrorCode {
  if (status >= 500) return status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
  return STATUS_TO_CODE[status] ?? 'INTERNAL_ERROR';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger?: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const res = ctx.getResponse<FastifyReply>();
    const requestId = String(req.id ?? 'unknown');

    let status: number;
    let code: ErrorCode;
    let message: string;
    let details: { path: string; code: string; message: string }[] | undefined;

    if (exception instanceof ApiError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof MachineError) {
      // domain state-machine violation carries its own HTTP mapping (§7.2/§7.3)
      status = exception.statusCode;
      code = exception.code as ErrorCode;
      message = exception.message;
    } else if (exception instanceof ZodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = 'Request validation failed.';
      details = exception.issues.map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        code: i.code,
        message: i.message,
      }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null && 'error' in response) {
        const envelope = (
          response as {
            error: { code?: string; message?: string; details?: typeof details };
          }
        ).error;
        code = (envelope.code as ErrorCode) ?? codeForStatus(status);
        message = envelope.message ?? exception.message;
        details = envelope.details;
      } else {
        code = codeForStatus(status);
        message = typeof response === 'string' ? response : exception.message;
      }
    } else {
      status = 500;
      code = 'INTERNAL_ERROR';
      message = 'Internal server error.';
      this.logger?.error(
        { requestId, err: exception instanceof Error ? exception.stack : String(exception) },
        'unhandled exception',
      );
    }

    res.status(status).send({
      error: { code, message, requestId, ...(details ? { details } : {}) },
    });
  }
}
