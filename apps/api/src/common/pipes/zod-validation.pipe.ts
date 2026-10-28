import { type PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';
import { ApiError } from '@lanxu/contracts';

/**
 * Single zod validation pipe for HTTP input (ADR-0005). Replaces per-framework
 * validator decorators: one schema language feeds runtime guards AND the
 * OpenAPI document. Failures → 400 VALIDATION_FAILED with path-level details.
 */
export class ZodValidationPipe implements PipeTransform<unknown, unknown> {
  constructor(
    private readonly schema: ZodType,
    private readonly target: 'body' | 'query' | 'param' = 'body',
  ) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Request ${this.target} validation failed.`,
        result.error.issues.map((i) => ({
          path: i.path.map(String).join('.') || '(root)',
          code: i.code,
          message: i.message,
        })),
      );
    }
    return result.data;
  }
}
