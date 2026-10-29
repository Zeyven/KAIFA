import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// NOTE: relative import — importing '@lanxu/db' by package name from inside this
// package resolves to its own dist outputs and breaks `tsc -b` (TS5055).
import { createPool, Migrator, MigrationError, type Pool } from './index';
import { isUuidV7 } from '@lanxu/domain';
import { startPgHarness, type PgHarness } from '@lanxu/testkit';

/**
 * Phase 01 gate (spec §19): migration fresh/up/down where safe, against REAL
 * PostgreSQL 18 — uniqueness/FK/CHECK invariants, UUIDv7 defaults, RBAC seed
 * matrix (§11), checksum tamper detection, concurrent-runner serialization.
 */

const PKG_ROOT = path.join(process.cwd(), 'packages', 'db');
const MIGRATIONS_DIR = path.join(PKG_ROOT, 'migrations');

async function pgErrorCode(fn: () => Promise<unknown>): Promise<{ code?: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as { code?: string };
  }
}

describe('Phase 01 — foundation migrations on real PostgreSQL', () => {
  let harness: PgHarness;
  let pool: Pool;
  let migrator: Migrator;

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-01-');
    pool = createPool(harness.connectionString, { max: 5, application_name: 'phase01-tests' });
    migrator = new Migrator(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await harness?.stop();
  });

  it('fresh: up() applies every migration exactly once and records its checksums', async () => {
    const before = await migrator.status();
    expect(before.applied).toEqual([]);

    const applied = await migrator.up();
    expect(applied).toEqual(['0001_foundation_identity', '0002_rooms_visits_audit_events']);

    const after = await migrator.status();
    expect(after.applied.map((a) => a.name)).toEqual([
      '0001_foundation_identity',
      '0002_rooms_visits_audit_events',
    ]);
    expect(after.pending).toEqual([]);
    expect(await migrator.isCurrent()).toBe(true);

    const crypto = await import('node:crypto');
    for (const name of applied) {
      const expectedChecksum = readFileSync(path.join(MIGRATIONS_DIR, `${name}.up.sql`), 'utf8');
      const sha = crypto.createHash('sha256').update(expectedChecksum).digest('hex');
      expect(after.applied.find((a) => a.name === name)?.checksum).toBe(sha);
    }
  });

  it('re-running up() is a no-op (idempotent)', async () => {
    expect(await migrator.up()).toEqual([]);
    const status = await migrator.status();
    expect(status.applied).toHaveLength(2);
  });

  it('all business PKs default to UUIDv7 (invariant I1)', async () => {
    const { rows } = await pool.query<{
      org_id: string;
      store_id: string;
      user_id: string;
    }>(
      `WITH org AS (
         INSERT INTO organizations (name, code) VALUES ('测试组织', 'ORG-UV7') RETURNING id
       ), store AS (
         INSERT INTO stores (organization_id, code, name)
         SELECT id, 'S1', '门店一' FROM org RETURNING id
       ), usr AS (
         INSERT INTO users (organization_id, username, password_hash)
         SELECT id, 'op01', 'scrypt$test' FROM org RETURNING id
       )
       SELECT (SELECT id FROM org) AS org_id, (SELECT id FROM store) AS store_id,
              (SELECT id FROM usr) AS user_id`,
    );
    for (const id of [rows[0]?.org_id, rows[0]?.store_id, rows[0]?.user_id]) {
      expect(id).toBeTruthy();
      expect(isUuidV7(id!)).toBe(true);
    }

    // bulk: 50 inserts — all v7, all unique
    const bulk = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, code)
       SELECT 'bulk-' || g, 'ORG-BULK-' || g FROM generate_series(1, 50) g RETURNING id`,
    );
    expect(bulk.rows).toHaveLength(50);
    expect(new Set(bulk.rows.map((r) => r.id)).size).toBe(50);
    expect(bulk.rows.every((r) => isUuidV7(r.id))).toBe(true);
  });

  it('store scope constraints: UNIQUE(org, code) + FK + status CHECK', async () => {
    const orgId = (
      await pool.query<{ id: string }>(`SELECT id FROM organizations WHERE code = 'ORG-UV7'`)
    ).rows[0]!.id;

    // duplicate store code within same org → 23505
    const dup = await pgErrorCode(() =>
      pool.query(`INSERT INTO stores (organization_id, code, name) VALUES ($1, 'S1', 'x')`, [
        orgId,
      ]),
    );
    expect(dup?.code).toBe('23505');

    // foreign org id → 23503
    const fk = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO stores (organization_id, code, name)
         VALUES ('0192f000-0000-7000-8000-0000000000ff', 'S-FK', 'x')`,
      ),
    );
    expect(fk?.code).toBe('23503');

    // bad status → 23514
    const chk = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO stores (organization_id, code, name, status)
                  VALUES ($1, 'S-CHK', 'x', 'ZOMBIE')`,
        [orgId],
      ),
    );
    expect(chk?.code).toBe('23514');

    // non-CNY currency rejected (V1 is CNY-only)
    const cur = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO stores (organization_id, code, name, currency)
                  VALUES ($1, 'S-USD', 'x', 'USD')`,
        [orgId],
      ),
    );
    expect(cur?.code).toBe('23514');
  });

  it('identity constraints: username scope, employee_no per store, LEFT needs date', async () => {
    const orgId = (
      await pool.query<{ id: string }>(`SELECT id FROM organizations WHERE code = 'ORG-UV7'`)
    ).rows[0]!.id;
    const storeId = (await pool.query<{ id: string }>(`SELECT id FROM stores WHERE code = 'S1'`))
      .rows[0]!.id;

    // duplicate username in same org → 23505 (different org would be fine)
    const dupUser = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO users (organization_id, username, password_hash) VALUES ($1, 'op01', 'x')`,
        [orgId],
      ),
    );
    expect(dupUser?.code).toBe('23505');

    // employee_no unique per store → 23505
    await pool.query(
      `INSERT INTO employees (organization_id, store_id, employee_no, display_name, employee_type)
       VALUES ($1, $2, 'E01', '张三', 'TECHNICIAN')`,
      [orgId, storeId],
    );
    const dupEmp = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO employees (organization_id, store_id, employee_no, display_name, employee_type)
         VALUES ($1, $2, 'E01', '李四', 'TECHNICIAN')`,
        [orgId, storeId],
      ),
    );
    expect(dupEmp?.code).toBe('23505');

    // employment_status LEFT without left_at → 23514
    const left = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO employees (organization_id, store_id, employee_no, display_name,
                                employee_type, employment_status)
         VALUES ($1, $2, 'E02', '王五', 'CASHIER', 'LEFT')`,
        [orgId, storeId],
      ),
    );
    expect(left?.code).toBe('23514');

    // left_at before joined_at → 23514
    const back = await pgErrorCode(() =>
      pool.query(
        `INSERT INTO employees (organization_id, store_id, employee_no, display_name,
                                employee_type, employment_status, joined_at, left_at)
         VALUES ($1, $2, 'E03', '赵六', 'CLEANER', 'LEFT', DATE '2026-10-01', DATE '2026-09-01')`,
        [orgId, storeId],
      ),
    );
    expect(back?.code).toBe('23514');
  });

  it('RBAC seed matches spec §11 matrix (spot checks)', async () => {
    const perms = await pool.query<{ code: string }>(`SELECT code FROM permissions`);
    expect(perms.rows.length).toBeGreaterThanOrEqual(15);

    const grants = await pool.query<{ role: string; perm: string }>(
      `SELECT r.code AS role, p.code AS perm
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id`,
    );
    const has = (role: string, perm: string) =>
      grants.rows.some((g) => g.role === role && g.perm === perm);

    expect(has('role.frontdesk', 'room.open')).toBe(true);
    expect(has('role.frontdesk', 'schedule.assign')).toBe(true);
    expect(has('role.frontdesk', 'refund.approve')).toBe(false); // △/– denied
    expect(has('role.cashier', 'order.checkout')).toBe(true);
    expect(has('role.cashier', 'schedule.assign')).toBe(false);
    expect(has('role.technician', 'service.self_start_stop')).toBe(true);
    expect(has('role.technician', 'order.checkout')).toBe(false);
    expect(has('role.clockroom', 'schedule.assign.force')).toBe(true);
    expect(has('role.finance', 'wallet.adjust')).toBe(true);
    expect(has('role.finance', 'room.open')).toBe(false);
    expect(has('role.manager', 'rbac.manage')).toBe(true);
    expect(has('role.boss', 'audit.read')).toBe(true);
    expect(has('role.boss', 'room.open')).toBe(true);

    // system roles are org-NULL + flagged; uniqueness across NULL orgs enforced
    const sys = await pool.query<{ code: string; system_role: boolean }>(
      `SELECT code, system_role FROM roles WHERE organization_id IS NULL`,
    );
    expect(sys.rows).toHaveLength(8);
    expect(sys.rows.every((r) => r.system_role)).toBe(true);
    const dup = await pgErrorCode(() =>
      pool.query(`INSERT INTO roles (organization_id, code, name, system_role)
                  VALUES (NULL, 'role.boss', 'dup', true)`),
    );
    expect(dup?.code).toBe('23505');
  });

  it('CLI: dist/cli.js status runs and reports current state', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const cli = path.join(PKG_ROOT, 'dist', 'cli.js');
    const { stdout } = await run(process.execPath, [cli, 'status'], {
      env: { ...process.env, DATABASE_URL: harness.connectionString },
      cwd: process.cwd(),
    });
    expect(stdout).toContain('applied (2): 0001_foundation_identity');
    expect(stdout).toContain('0002_rooms_visits_audit_events');
    expect(stdout).toContain('pending (0)');
  });

  it('checksum tamper detection: edited applied migration is rejected', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'lanxu-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, path.join(tmp, 'migrations'), { recursive: true });
      const tamperMigrator = new Migrator(pool, path.join(tmp, 'migrations'));
      await tamperMigrator.up(); // no-op (already applied) but validates checksums pass
      await expect(tamperMigrator.verifyChecksums()).resolves.toBeUndefined();

      appendFileSync(
        path.join(tmp, 'migrations', '0001_foundation_identity.up.sql'),
        '\n-- sneaky edit\n',
      );
      await expect(tamperMigrator.verifyChecksums()).rejects.toThrow(MigrationError);
      await expect(tamperMigrator.up()).rejects.toThrow(/checksum/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('down(2) reverts full schema, then concurrent up() applies exactly once (spec §18.2 + §6.4 discipline)', async () => {
    const reverted = await migrator.down(2);
    expect(reverted).toEqual(['0002_rooms_visits_audit_events', '0001_foundation_identity']);

    const gone = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('public.organizations') AS t`,
    );
    expect(gone.rows[0]?.t).toBeNull();
    const revertedStatus = await migrator.status();
    expect(revertedStatus.applied).toEqual([]);
    expect(revertedStatus.pending.map((p) => p.name)).toEqual([
      '0001_foundation_identity',
      '0002_rooms_visits_audit_events',
    ]);

    // two runners race the real apply — advisory lock must serialize them
    const results = await Promise.allSettled([migrator.up(), migrator.up()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const status = await migrator.status();
    expect(status.applied.map((a) => a.name)).toEqual([
      '0001_foundation_identity',
      '0002_rooms_visits_audit_events',
    ]); // exactly once, both
    expect(await migrator.isCurrent()).toBe(true);

    const back = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('public.organizations') AS t`,
    );
    // to_regclass returns the unqualified name when the schema is in search_path
    expect(['organizations', 'public.organizations']).toContain(back.rows[0]?.t);

    // 0002's own objects are back too (rooms/audit chain restorable)
    const rooms = await pool.query<{ t: string | null }>(`SELECT to_regclass('public.rooms') AS t`);
    expect(['rooms', 'public.rooms']).toContain(rooms.rows[0]?.t);
  });
});
