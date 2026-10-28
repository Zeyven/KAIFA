import { Pool, type PoolConfig } from 'pg';

/** Create a pg Pool with sane operational defaults (spec: readiness, timeouts). */
export function createPool(databaseUrl: string, overrides: PoolConfig = {}): Pool {
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: overrides.max ?? 10,
    idleTimeoutMillis: overrides.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: overrides.connectionTimeoutMillis ?? 5_000,
    application_name: overrides.application_name ?? 'lanxu',
    statement_timeout: overrides.statement_timeout ?? 15_000,
    ...overrides,
  };
  return new Pool(config);
}

export type { Pool };
