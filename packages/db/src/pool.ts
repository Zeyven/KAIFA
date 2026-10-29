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
  const pool = new Pool(config);
  // pg contract: async errors on IDLE clients are emitted on the pool. Without a
  // listener Node escalates them to uncaught exceptions (e.g. a test harness
  // stopping the server while a socket is mid-close → FATAL 57P01). Queries in
  // flight still reject normally — tests keep failing loudly on real query loss;
  // this listener only covers socket-level noise that no query is waiting on.
  pool.on('error', (err: Error) => {
    console.error(
      `[lanxu-db] idle connection error (${databaseUrl.split('@')[1] ?? 'db'}): ${err.message}`,
    );
  });
  return pool;
}

export type { Pool };
