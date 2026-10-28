import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { startPgHarness, type PgHarness } from './pg-harness';
import { createPool, Migrator, type Pool } from '@lanxu/db';

/**
 * Phase 00 environment smoke (ADR-0003): the embedded cluster must be REAL
 * PostgreSQL 18 with working advisory locks (migration serialization depends
 * on them). Also proves the migrator runs cleanly on an empty history.
 */
describe('embedded PostgreSQL harness', () => {
  let harness: PgHarness;
  let pool: Pool;

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-smoke-');
    pool = createPool(harness.connectionString, { max: 4, application_name: 'smoke-test' });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await harness?.stop();
  });

  it('boots PostgreSQL 18 (real binaries, not an emulator)', async () => {
    const { rows } = await pool.query<{ version: string }>('SELECT version() AS version');
    expect(rows[0]?.version).toContain('PostgreSQL 18');
    expect(rows[0]?.version).not.toMatch(/PGlite|SQLite/i);
  });

  it('supports advisory locks (migration serialization primitive)', async () => {
    const a = createPool(harness.connectionString, { max: 1 });
    const b = createPool(harness.connectionString, { max: 1 });
    try {
      const clientA = await a.connect();
      await clientA.query('SELECT pg_advisory_lock(4242)');
      // lock is session-scoped: B's attempt must NOT be granted while A holds it
      const got = await Promise.race([
        b.query('SELECT pg_advisory_lock(4242)').then(() => 'granted'),
        new Promise((r) => setTimeout(() => r('blocked'), 300)),
      ]);
      expect(got).toBe('blocked');
      await clientA.query('SELECT pg_advisory_unlock(4242)');
      clientA.release();
      const { rows } = await b.query('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
      await b.query('SELECT pg_advisory_unlock(4242)').catch(() => undefined);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('migrator: fresh DB → status clean, up() no-op with zero migrations', async () => {
    const migrator = new Migrator(pool);
    const status = await migrator.status();
    expect(status.applied).toEqual([]);
    expect(status.pending).toEqual([]); // Phase 00 ships no SQL yet; Phase 01 adds 0001
    const applied = await migrator.up();
    expect(applied).toEqual([]);
    expect(await migrator.isCurrent()).toBe(true);
  });
});
