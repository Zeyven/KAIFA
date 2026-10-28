import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Real PostgreSQL test harness (ADR-0003, spec §17.1 — no SQLite stand-ins).
 *
 * Boots a throwaway PostgreSQL 18 cluster from npm-shipped binaries on a free
 * port, or yields an externally provided DATABASE_URL untouched.
 */

export interface PgHarness {
  connectionString: string;
  /** True when backed by embedded binaries (vs an external DATABASE_URL). */
  embedded: boolean;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to allocate port'));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export async function startPgHarness(prefix = 'lanxu-pg-'): Promise<PgHarness> {
  const external = process.env.DATABASE_URL;
  if (external && !process.env.LANXU_FORCE_EMBEDDED_PG) {
    return { connectionString: external, embedded: false, stop: async () => {} };
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), prefix));
  const port = await freePort();
  const user = 'lanxu';
  const password = 'lanxu_test_password';

  // embedded-postgres ships ESM only; dynamic import keeps this CJS package
  // compatible (Node >= 22.12 require(esm) + vitest/vite interop). The class
  // type is inferred from the import — no static ESM type import (TS1541).
  const { default: EmbeddedPostgresCtor } = await import('embedded-postgres');
  const client = new EmbeddedPostgresCtor({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
  });

  await client.initialise();
  await client.start();
  await client.createDatabase('lanxu_test');

  return {
    connectionString: `postgres://${user}:${password}@127.0.0.1:${port}/lanxu_test`,
    embedded: true,
    stop: async () => {
      try {
        await client.stop();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/** Poll until `fn` returns truthy or timeout (eventual consistency in tests). */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) return value as T;
      last = value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${opts.label ? ` (${opts.label})` : ''}: last=${String(last)}`);
}
