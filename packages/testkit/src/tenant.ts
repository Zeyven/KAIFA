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
  /** Frontdesk aide at store A (has NOT tech.manage — negative authz tests). */
  aideUserId: string;
  aideUsername: string;
  aideEmployeeId: string;
  /** Store A technicians (no login accounts — employee rows only). */
  tech1: string;
  tech2: string;
  /** Aide's own technician (self-service allowed without tech.manage). */
  tech3: string;
  /** Technician with NO shift row (clock-in guard → FORBIDDEN). */
  tech4: string;
  /** Sample catalog (org-scoped) for skill checks. */
  serviceVariantId: string;
  serviceVariantId2: string;
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

    // aide: frontdesk at store A (no tech.manage grant) + own technician
    const aide = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, username, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [orgId, `aide_${suffix.toLowerCase()}`, passwordHash],
    );
    const aideUserId = aide.rows[0]!.id;
    const aideEmp = await client.query<{ id: string }>(
      `INSERT INTO employees (organization_id, store_id, user_id, employee_no, display_name, employee_type)
       VALUES ($1, $2, $3, $4, 'Aide Test', 'FRONTDESK') RETURNING id`,
      [orgId, storeA, aideUserId, `E-AID-${suffix}`],
    );
    const aideEmployeeId = aideEmp.rows[0]!.id;
    await client.query(
      `INSERT INTO employee_roles (employee_id, role_id, store_id)
       SELECT $1, id, $2 FROM roles WHERE code = 'role.frontdesk'`,
      [aideEmployeeId, storeA],
    );

    // catalog subset (org-scoped) — skill targets
    const cat = await client.query<{ id: string }>(
      `INSERT INTO service_categories (store_id, name, sort_order) VALUES ($1, '足浴', 1) RETURNING id`,
      [storeA],
    );
    const svc = await client.query<{ id: string }>(
      `INSERT INTO services (organization_id, code, name, category_id)
       VALUES ($1, $2, '经典足浴', $3) RETURNING id`,
      [orgId, `SVC-${suffix}`, cat.rows[0]!.id],
    );
    const variants = await client.query<{ id: string; code: string }>(
      `INSERT INTO service_variants (service_id, code, name, duration_minutes, base_price_cents)
       VALUES ($1, 'V90', '90分钟', 90, 29800), ($1, 'V60', '60分钟', 60, 19800)
       RETURNING id, code`,
      [svc.rows[0]!.id],
    );
    const serviceVariantId = variants.rows.find((v) => v.code === 'V90')!.id;
    const serviceVariantId2 = variants.rows.find((v) => v.code === 'V60')!.id;

    // technicians: tech1/tech2 skilled + shopped-in; tech3 = aide's own (shifted);
    // tech4 = deliberately shiftless (clock-in guard negative case)
    const techRows = await client.query<{ id: string; no: string }>(
      `INSERT INTO employees (organization_id, store_id, employee_no, display_name, employee_type)
       VALUES ($1, $2, 'T-001', '技师一', 'TECHNICIAN'),
              ($1, $2, 'T-002', '技师二', 'TECHNICIAN'),
              ($1, $2, 'T-003', '技师三', 'TECHNICIAN'),
              ($1, $2, 'T-004', '技师四', 'TECHNICIAN')
       RETURNING id, employee_no AS no`,
      [orgId, storeA],
    );
    const empByNo = new Map(techRows.rows.map((r) => [r.no, r.id]));
    if (empByNo.size !== 4) throw new Error('seedTenant: technician employees missing');
    const techOf = async (employeeNo: string): Promise<string> => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO technicians (employee_id, store_id, technician_no, queue_enabled)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [empByNo.get(employeeNo)!, storeA, employeeNo.replace('T-', 'T')],
      );
      return r.rows[0]!.id;
    };
    const tech1 = await techOf('T-001');
    const tech2 = await techOf('T-002');
    // tech3 = THE AIDE's own technician record (self-service without tech.manage)
    const tech3Row = await client.query<{ id: string }>(
      `INSERT INTO technicians (employee_id, store_id, technician_no, queue_enabled)
       VALUES ($1, $2, 'TA3', true) RETURNING id`,
      [aideEmployeeId, storeA],
    );
    const tech3 = tech3Row.rows[0]!.id;
    const tech4 = await techOf('T-004');

    await client.query(
      `INSERT INTO technician_shifts (technician_id, store_id, starts_at, ends_at, status)
       SELECT t.id, $1, now() - interval '1 hour', now() + interval '8 hours', 'ACTIVE'
       FROM technicians t WHERE t.id = ANY($2::uuid[])`,
      [storeA, [tech1, tech2, tech3]], // tech4 intentionally has no shift
    );
    await client.query(
      `INSERT INTO technician_skills (technician_id, service_variant_id, skill_level, enabled)
       VALUES ($1, $2, 5, true), ($1, $3, 3, true), ($4, $3, 4, true)`,
      [tech1, serviceVariantId, serviceVariantId2, tech2],
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
      aideUserId,
      aideUsername: `aide_${suffix.toLowerCase()}`,
      aideEmployeeId,
      tech1,
      tech2,
      tech3,
      tech4,
      serviceVariantId,
      serviceVariantId2,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
