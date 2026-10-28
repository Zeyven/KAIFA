import { z } from 'zod';

/**
 * Environment loading (zod-validated). Secrets come from env/KMS only —
 * never repo, never APK (SECURITY.md). Production guards (fake provider,
 * default JWT secret) fail closed — see envSchema refinement below.
 */

const DEV_JWT_SECRET_PREFIX = 'dev-only';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\/\S+$/, 'DATABASE_URL must be a postgres URL')
      .optional(),
    REDIS_URL: z
      .string()
      .regex(/^redis(s)?:\/\/\S+$/)
      .optional(),
    JWT_SECRET: z.string().min(32).default('dev-only-insecure-jwt-secret-change-me-0000000000'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
    PAYMENT_PROVIDER: z.enum(['fake', 'wechat', 'alipay', 'aggregate']).default('fake'),
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      (!env.JWT_SECRET.startsWith(DEV_JWT_SECRET_PREFIX) &&
        env.JWT_SECRET !== 'dev-only-insecure-jwt-secret-change-me-0000000000'),
    {
      message: 'JWT_SECRET must be rotated away from the dev default in production',
      path: ['JWT_SECRET'],
    },
  )
  .refine((env) => env.NODE_ENV !== 'production' || env.PAYMENT_PROVIDER !== 'fake', {
    message: 'PAYMENT_PROVIDER=fake is forbidden in production (fail closed, spec §13.2)',
    path: ['PAYMENT_PROVIDER'],
  });

export type AppEnv = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid environment: ${issues.join('; ')}`);
    this.name = 'EnvError';
  }
}

/** Parse + validate env. Throws EnvError with ALL issues listed (never logs values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const candidate = {
    NODE_ENV: source.NODE_ENV,
    PORT: source.PORT,
    LOG_LEVEL: source.LOG_LEVEL,
    DATABASE_URL: source.DATABASE_URL || undefined,
    REDIS_URL: source.REDIS_URL || undefined,
    JWT_SECRET: source.JWT_SECRET,
    JWT_ACCESS_TTL_SECONDS: source.JWT_ACCESS_TTL_SECONDS,
    PAYMENT_PROVIDER: source.PAYMENT_PROVIDER,
  };
  const result = envSchema.safeParse(candidate);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
