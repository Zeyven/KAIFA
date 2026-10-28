import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Checksummed SQL migration runner (spec §18.2).
 *
 * - Files: `migrations/NNNN_name.up.sql` with optional `NNNN_name.down.sql`
 *   (a migration without a down file is irreversible → `down` refuses to cross it).
 * - `schema_migrations` records name, sha256 of the up file, applied_at, duration_ms.
 * - Applied migrations whose file changed → checksum error (tamper detection).
 * - Concurrent runs serialize on a Postgres advisory lock.
 * - Each migration applies in ONE transaction (partial failure = no half state).
 */

export interface MigrationFile {
  name: string;
  upPath: string;
  downPath: string | null;
  upSql: string;
  checksum: string; // sha256 of upSql
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  applied_at: Date;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const MIGRATION_RE = /^(\d{4}_[a-z0-9_]+)\.up\.sql$/;

export function resolveMigrationsDir(explicit?: string): string {
  if (explicit) return explicit;
  // dist/migrator.js → ../migrations ; src/migrator.ts (vitest) → ../migrations
  return path.join(__dirname, '..', 'migrations');
}

export function loadMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_RE.test(f))
    .sort();
  return files.map((file) => {
    const name = file.replace(/\.up\.sql$/, '');
    const upPath = path.join(dir, file);
    const downPath = path.join(dir, `${name}.down.sql`);
    const upSql = readFileSync(upPath, 'utf8');
    return {
      name,
      upPath,
      downPath: existsSync(downPath) ? downPath : null,
      upSql,
      checksum: createHash('sha256').update(upSql).digest('hex'),
    };
  });
}

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0
);`;

/** Session-level advisory lock id for migration serialization. */
const MIGRATION_LOCK_ID = 8_675_309;

/** Postgres error code: relation does not exist (fresh database). */
const UNDEFINED_TABLE = '42P01';

async function queryApplied(
  run: <R extends QueryResultRow>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>,
): Promise<AppliedMigration[]> {
  try {
    const { rows } = await run<AppliedMigration>(
      'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
    );
    return rows;
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

export class Migrator {
  constructor(
    private readonly pool: Pool,
    private readonly dir: string = resolveMigrationsDir(),
  ) {}

  private async withLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      return await fn(client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } finally {
        client.release();
      }
    }
  }

  async status(): Promise<{ applied: AppliedMigration[]; pending: MigrationFile[] }> {
    const files = loadMigrations(this.dir);
    const rows = await queryApplied(<R extends QueryResultRow>(sql: string, params?: unknown[]) =>
      this.pool.query<R>(sql, params),
    );
    const appliedByName = new Map(rows.map((r) => [r.name, r]));
    const pending = files.filter((f) => !appliedByName.has(f.name));
    return { applied: rows, pending };
  }

  /** Fail if any applied migration's file content changed (tamper / edit-after-apply). */
  async verifyChecksums(): Promise<void> {
    const files = loadMigrations(this.dir);
    const byName = new Map(files.map((f) => [f.name, f]));
    const rows = await queryApplied(<R extends QueryResultRow>(sql: string, params?: unknown[]) =>
      this.pool.query<R>(sql, params),
    );
    for (const row of rows) {
      const file = byName.get(row.name);
      if (!file) {
        throw new MigrationError(
          `applied migration ${row.name} has no file — history rewritten? (restore file or audit)`,
        );
      }
      if (file.checksum !== row.checksum) {
        throw new MigrationError(
          `checksum mismatch for ${row.name}: applied=${row.checksum.slice(0, 12)}… ` +
            `file=${file.checksum.slice(0, 12)}… — edited migrations are forbidden after apply`,
        );
      }
    }
  }

  /** Apply all pending migrations in order. Returns names applied. */
  async up(): Promise<string[]> {
    return this.withLock(async (client) => {
      await client.query(MIGRATIONS_DDL);
      await this.verifyChecksumsOn(client);
      const files = loadMigrations(this.dir);
      const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.name));
      const appliedNow: string[] = [];
      for (const file of files) {
        if (applied.has(file.name)) continue;
        const started = Date.now();
        try {
          await client.query('BEGIN');
          await client.query(file.upSql);
          await client.query(
            'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
            [file.name, file.checksum, Date.now() - started],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new MigrationError(`migration ${file.name} failed: ${(err as Error).message}`);
        }
        appliedNow.push(file.name);
      }
      return appliedNow;
    });
  }

  /**
   * Revert `steps` migrations (newest first). Refuses to cross an irreversible
   * migration (no .down.sql) and refuses if a later applied file is tampered.
   */
  async down(steps = 1): Promise<string[]> {
    if (steps < 1) throw new MigrationError('down: steps must be >= 1');
    return this.withLock(async (client) => {
      await client.query(MIGRATIONS_DDL);
      await this.verifyChecksumsOn(client);
      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT $1',
        [steps],
      );
      const reverted: string[] = [];
      for (const row of rows) {
        const file = loadMigrations(this.dir).find((f) => f.name === row.name);
        if (!file) throw new MigrationError(`cannot down: file for ${row.name} missing`);
        if (!file.downPath) {
          throw new MigrationError(
            `migration ${row.name} is irreversible (no ${row.name}.down.sql) — ` +
              'use a forward compensating migration instead',
          );
        }
        const downSql = readFileSync(file.downPath, 'utf8');
        try {
          await client.query('BEGIN');
          await client.query(downSql);
          await client.query('DELETE FROM schema_migrations WHERE name = $1', [file.name]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new MigrationError(`down ${file.name} failed: ${(err as Error).message}`);
        }
        reverted.push(file.name);
      }
      return reverted;
    });
  }

  /** True when files and applied set are in sync (readiness check uses this). */
  async isCurrent(): Promise<boolean> {
    const { pending } = await this.status();
    if (pending.length > 0) return false;
    await this.verifyChecksums();
    return true;
  }

  private async verifyChecksumsOn(client: PoolClient): Promise<void> {
    const files = loadMigrations(this.dir);
    const byName = new Map(files.map((f) => [f.name, f]));
    const { rows } = await client.query<AppliedMigration>(
      'SELECT name, checksum FROM schema_migrations',
    );
    for (const row of rows) {
      const file = byName.get(row.name);
      if (!file) {
        throw new MigrationError(`applied migration ${row.name} has no file — history rewritten?`);
      }
      if (file.checksum !== row.checksum) {
        throw new MigrationError(`checksum mismatch for ${row.name} — migrations are append-only`);
      }
    }
  }
}
