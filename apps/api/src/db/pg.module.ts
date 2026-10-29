import {
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
  Injectable,
  type Provider,
} from '@nestjs/common';
import { type AppEnv } from '@lanxu/config';
import { createPool, type Pool } from '@lanxu/db';
import { ENV, EnvModule } from '../env/env.module';

/** Application-wide Postgres pool (null when DATABASE_URL unset — dev without DB). */
export const PG_POOL = 'LANXU_PG_POOL';

const poolProvider: Provider = {
  provide: PG_POOL,
  inject: [ENV],
  useFactory: (env: AppEnv): Pool | null => {
    if (!env.DATABASE_URL) return null;
    return createPool(env.DATABASE_URL, { max: 10, application_name: 'lanxu-api' });
  },
};

/** Closes the shared pool on app teardown so processes/tests exit cleanly. */
@Injectable()
class PoolCloser implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}
  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

@Global()
@Module({
  imports: [EnvModule],
  providers: [poolProvider, PoolCloser],
  exports: [PG_POOL],
})
export class DatabaseModule {}

export type { Pool };
export function requirePool(pool: Pool | null): Pool {
  if (!pool) throw new Error('DATABASE_URL not configured — database unavailable');
  return pool;
}
