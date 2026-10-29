import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { ApiError } from '@lanxu/contracts';
import { hashPassword, verifyPassword } from '@lanxu/domain';
import { AuditService } from '../audit/audit.service';
import { PG_POOL, requirePool } from '../db/pg.module';
import { JwtService } from './jwt.service';

interface LoginAttempt {
  count: number;
  resetAt: number;
}

/** Failed-login throttle (dev single-instance; Redis-backed limiter lands with edge/queue phases). */
const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export interface EffectivePermissions {
  employeeId: string;
  permissions: string[];
}

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, LoginAttempt>();
  private dummyHash!: string;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // precomputed verifier so missing-user logins cost the same as real ones
    this.dummyHash = await hashPassword('lanxu-dummy-timing-equalizer');
  }

  private db(): Pool {
    return requirePool(this.pool);
  }

  private blocked(key: string): boolean {
    const entry = this.attempts.get(key);
    return !!entry && entry.count >= MAX_FAILED_ATTEMPTS && entry.resetAt > Date.now();
  }

  private registerFailure(key: string): number {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  private clearFailures(key: string): void {
    this.attempts.delete(key);
  }

  async login(input: {
    orgCode: string;
    username: string;
    password: string;
    ip?: string;
  }): Promise<{
    token: string;
    expiresIn: number;
    user: { id: string; orgId: string; username: string };
    stores: Array<{ id: string; code: string; name: string }>;
  }> {
    const key = `${input.ip ?? '-'}|${input.orgCode}|${input.username}`;
    if (this.blocked(key)) {
      await this.audit.security({
        eventType: 'LOGIN_RATE_LIMITED',
        actorHint: `${input.orgCode}/${input.username}`,
        ip: input.ip,
      });
      throw new ApiError('RATE_LIMITED', 'Too many failed attempts. Try again shortly.');
    }

    const { rows } = await this.db().query<{
      id: string;
      organization_id: string;
      password_hash: string;
      status: string;
      org_status: string;
    }>(
      `SELECT u.id, u.organization_id, u.password_hash, u.status, o.status AS org_status
       FROM users u JOIN organizations o ON o.id = u.organization_id
       WHERE o.code = $1 AND u.username = $2`,
      [input.orgCode, input.username],
    );
    const user = rows[0];
    const ok =
      !!user &&
      (await verifyPassword(input.password, user.password_hash)) &&
      user.status === 'ACTIVE' &&
      user.org_status === 'ACTIVE';

    if (!ok) {
      const count = this.registerFailure(key);
      await this.audit.security({
        organizationId: user?.organization_id,
        eventType: count >= MAX_FAILED_ATTEMPTS ? 'LOGIN_FAILED_LOCKED' : 'LOGIN_FAILED',
        actorHint: `${input.orgCode}/${input.username}`,
        ip: input.ip,
        metadata: { attempt: count },
      });
      // constant-shape failure: unknown user vs bad password indistinguishable
      throw new ApiError('UNAUTHENTICATED', 'Invalid credentials.');
    }

    this.clearFailures(key);
    await this.db().query(
      `UPDATE users SET last_login_at = now(), failed_login_count = 0
                           WHERE id = $1`,
      [user!.id],
    );
    await this.audit.security({
      organizationId: user!.organization_id,
      eventType: 'LOGIN_SUCCESS',
      actorHint: `${input.orgCode}/${input.username}`,
      ip: input.ip,
    });

    const storesRes = await this.db().query<{ id: string; code: string; name: string }>(
      `SELECT s.id, s.code, s.name
       FROM stores s JOIN employees e ON e.store_id = s.id
       WHERE s.organization_id = $1 AND e.user_id = $2 AND e.employment_status = 'ACTIVE'
         AND s.status = 'ACTIVE'
       ORDER BY s.code`,
      [user!.organization_id, user!.id],
    );

    const { token, expiresIn } = await this.jwt.sign({
      sub: user!.id,
      orgId: user!.organization_id,
      username: input.username,
    });
    return {
      token,
      expiresIn,
      user: { id: user!.id, orgId: user!.organization_id, username: input.username },
      stores: storesRes.rows,
    };
  }

  /** Effective permission codes for (user, store) — fresh from DB, never from JWT. */
  async effectivePermissions(userId: string, storeId: string): Promise<EffectivePermissions> {
    const { rows } = await this.db().query<{ employee_id: string; code: string | null }>(
      `SELECT e.id AS employee_id, p.code
       FROM employees e
       LEFT JOIN employee_roles er ON er.employee_id = e.id AND er.store_id = e.store_id
       LEFT JOIN role_permissions rp ON rp.role_id = er.role_id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE e.user_id = $1 AND e.store_id = $2 AND e.employment_status = 'ACTIVE'`,
      [userId, storeId],
    );
    if (rows.length === 0 || !rows[0]?.employee_id) {
      throw new ApiError('UNAUTHORIZED_SCOPE', 'No active employee record for this store.');
    }
    const permissions = [
      ...new Set(rows.map((r) => r.code).filter((c): c is string => c !== null)),
    ].sort();
    return { employeeId: rows[0].employee_id, permissions };
  }

  async identity(userId: string): Promise<{
    id: string;
    orgId: string;
    username: string;
    stores: Array<{ id: string; code: string; name: string }>;
    permissions: string[] | null;
    storeId: string | null;
  }> {
    const { rows } = await this.db().query<{
      id: string;
      organization_id: string;
      username: string;
    }>(`SELECT id, organization_id, username FROM users WHERE id = $1 AND status = 'ACTIVE'`, [
      userId,
    ]);
    const user = rows[0];
    if (!user) throw new ApiError('UNAUTHENTICATED', 'Account is not active.');
    const stores = await this.db().query<{ id: string; code: string; name: string }>(
      `SELECT s.id, s.code, s.name FROM stores s
       JOIN employees e ON e.store_id = s.id
       WHERE e.user_id = $1 AND e.employment_status = 'ACTIVE' AND s.status = 'ACTIVE'
       ORDER BY s.code`,
      [userId],
    );
    return {
      id: user.id,
      orgId: user.organization_id,
      username: user.username,
      stores: stores.rows,
      permissions: null,
      storeId: null,
    };
  }
}
