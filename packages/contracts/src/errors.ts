import { z } from 'zod';

/**
 * Canonical error codes — clients branch on `code`, NEVER on English `message`
 * (Master Prompt §7.1). Adding a code: add it here + doc entry in
 * docs/architecture/state-machines.md error registry.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'UNAUTHORIZED_SCOPE',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'ROOM_NOT_ELIGIBLE',
  'ROOM_OCCUPIED',
  'TECHNICIAN_NOT_AVAILABLE',
  'TECHNICIAN_LOCKED',
  'ROOM_BOUND_TO_OTHER_DEVICE',
  'ORDER_HAS_ACTIVE_SERVICE',
  'BALANCE_INSUFFICIENT',
  'APPROVAL_REQUIRED',
  'PROVIDER_VERIFICATION_FAILED',
  'RATE_LIMITED',
  'DEVICE_DISABLED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** HTTP status for each code (spec §7.2 semantics). */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  UNAUTHORIZED_SCOPE: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE_TRANSITION: 422,
  ROOM_NOT_ELIGIBLE: 422,
  ROOM_OCCUPIED: 422,
  TECHNICIAN_NOT_AVAILABLE: 422,
  TECHNICIAN_LOCKED: 422,
  ROOM_BOUND_TO_OTHER_DEVICE: 409,
  ORDER_HAS_ACTIVE_SERVICE: 422,
  BALANCE_INSUFFICIENT: 422,
  APPROVAL_REQUIRED: 422,
  PROVIDER_VERIFICATION_FAILED: 422,
  RATE_LIMITED: 429,
  DEVICE_DISABLED: 403,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function statusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z
      .array(z.object({ path: z.string(), code: z.string(), message: z.string() }))
      .optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const apiSuccessSchema = z.object({ data: z.unknown() });
export type ApiSuccessBody<T> = { data: T };

/**
 * Typed application error. Thrown by services, rendered by the API exception
 * filter into the wire envelope. Never contains secrets.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: { path: string; code: string; message: string }[];

  constructor(
    code: ErrorCode,
    message?: string,
    details?: { path: string; code: string; message: string }[],
  ) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = statusForErrorCode(code);
    this.details = details;
  }
}
