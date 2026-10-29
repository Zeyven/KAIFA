import type { Pool } from 'pg';
import { hashPassword } from '@lanxu/domain';

/**
 * Integration-test tenant factory: seeds one org, two stores (A main / B branch),
 * a boss user at A, a frontdesk user at B, and four rooms (3 at A, 1 at B).
 * Uses the real domain password hash and real RBAC grant path — never bypasses
 * authorization to make tests pass.
 */
export interface TenantFixture {
  orgId: string;
  orgCode: string;
  storeA: string;
  storeB: string;
  /** Boss at store A — full permission set (incl. every room.* code). */
  bossUserId: string;
  bossUsername: string;
  password: string;
  bossEmployeeId: string;
  /** Frontdesk at store B — used for cross-store negative tests. */
  clerkUserId: string;
  clerkUsername: string;
  clerkEmployeeId: string;
  /** Store A rooms. */
  roomClean1: string;
  roomClean2: string;
  roomDirty: string;
  /** Store B room (cross-store target must 404). */
  roomOtherStore: string;
}

export async function seedTenant(
  pool: Pool,
  opts: { orgCode?: string } = {},
): Promise<TenantFixture> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const orgCode = opts.orgCode ?? `T${suffix}`;
  const password = 'Sx9!tK2vQm7Lp';
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (code, name) VALUES ($1, $2) RETURNING id`,
      [orgCode, `Tenant ${orgCode}`],
    );
    const orgId = org.rows[0]!.id;

    const stores = await client.query<{ id: string; code: string }>(
      `INSERT INTO stores (organization_id, code, name) VALUES ($1, 'S01', 'Main Store'), ($1, 'S02', 'Branch Store')
       RETURNING id, code`,
      [orgId],
    );
    const storeA = stores.rows.find((s) => s.code === 'S01')!.id;
    const storeB = stores.rows.find((s) => s.code === 'S02')!.id;

    const boss = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, username, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [orgId, `boss_${suffix.toLowerCase()}`, passwordHash],
    );
    const bossUserId = boss.rows[0]!.id;

    const clerk = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, username, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [orgId, `clerk_${suffix.toLowerCase()}`, passwordHash],
    );
    const clerkUserId = clerk.rows[0]!.id;

    const bossEmp = await client.query<{ id: string }>(
      `INSERT INTO employees (organization_id, store_id, user_id, employee_no, display_name, employee_type)
       VALUES ($1, $2, $3, $4, 'Boss Test', 'BOSS') RETURNING id`,
      [orgId, storeA, bossUserId, `E-BOSS-${suffix}`],
    );
    const bossEmployeeId = bossEmp.rows[0]!.id;

    const clerkEmp = await client.query<{ id: string }>(
      `INSERT INTO employees (organization_id, store_id, user_id, employee_no, display_name, employee_type)
       VALUES ($1, $2, $3, $4, 'Clerk Test', 'FRONTDESK') RETURNING id`,
      [orgId, storeB, clerkUserId, `E-CLK-${suffix}`],
    );
    const clerkEmployeeId = clerkEmp.rows[0]!.id;

    // system roles live with organization_id NULL; grant them per store
    await client.query(
      `INSERT INTO employee_roles (employee_id, role_id, store_id)
       SELECT $1, id, $2 FROM roles WHERE code = 'role.boss'`,
      [bossEmployeeId, storeA],
    );
    await client.query(
      `INSERT INTO employee_roles (employee_id, role_id, store_id)
       SELECT $1, id, $2 FROM roles WHERE code = 'role.frontdesk'`,
      [clerkEmployeeId, storeB],
    );

    const rooms = await client.query<{ id: string; code: string }>(
      `INSERT INTO rooms (store_id, code, name, operational_state, status)
       VALUES ($1, 'R101', 'Room 101', 'VACANT_CLEAN', 'ACTIVE'),
              ($1, 'R102', 'Room 102', 'VACANT_CLEAN', 'ACTIVE'),
              ($1, 'R103', 'Room 103', 'DIRTY', 'ACTIVE'),
              ($2, 'B101', 'Branch 101', 'VACANT_CLEAN', 'ACTIVE')
       RETURNING id, code`,
      [storeA, storeB],
    );
    const byCode = new Map(rooms.rows.map((r) => [r.code, r.id]));

    await client.query('COMMIT');

    return {
      orgId,
      orgCode,
      storeA,
      storeB,
      bossUserId,
      bossUsername: `boss_${suffix.toLowerCase()}`,
      password,
      bossEmployeeId,
      clerkUserId,
      clerkUsername: `clerk_${suffix.toLowerCase()}`,
      clerkEmployeeId,
      roomClean1: byCode.get('R101')!,
      roomClean2: byCode.get('R102')!,
      roomDirty: byCode.get('R103')!,
      roomOtherStore: byCode.get('B101')!,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
