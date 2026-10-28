import { Module } from '@nestjs/common';
import { loadEnv, type AppEnv } from '@lanxu/config';

/** DI token for the validated environment object. */
export const ENV = 'LANXU_ENV';

/**
 * Provides the zod-validated environment as a DI value. Tests override this
 * token instead of mutating process.env after boot.
 */
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class EnvModule {}

export type { AppEnv };
