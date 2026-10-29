import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ApiError } from '@lanxu/contracts';
import { NO_STORE_SCOPE_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../../common/decorators';
import { PG_POOL, requirePool } from '../../db/pg.module';
import { AuditService } from '../../audit/audit.service';
import { AuthService } from '../auth.service';
import { JwtService } from '../jwt.service';

/**
 * Global authorization pipeline, executed in one deterministic order:
 *   public-skip → JWT → store scope (X-Store-Id) → permission codes.
 * Object-level checks still happen inside each command service (belt and
 * suspenders — OWASP API1).
 */
@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PG_POOL) private readonly pool: Pool | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const cls = context.getClass();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, cls])) {
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new ApiError('UNAUTHENTICATED', 'Missing bearer token.');
    }
    const payload = await this.jwt.verify(header.slice('Bearer '.length));
    req.principal = { userId: payload.sub, orgId: payload.orgId, username: payload.username };

    const noStore = this.reflector.getAllAndOverride<boolean>(NO_STORE_SCOPE_KEY, [handler, cls]);
    if (noStore) return true;

    const rawStore = req.headers['x-store-id'];
    const storeId = Array.isArray(rawStore) ? rawStore[0] : rawStore;
    if (!storeId || !/^[0-9a-f-]{36}$/i.test(storeId)) {
      throw new ApiError('UNAUTHORIZED_SCOPE', 'A valid X-Store-Id header is required.');
    }

    const pool = requirePool(this.pool);
    const storeRes = await pool.query<{ organization_id: string; status: string }>(
      `SELECT organization_id, status FROM stores WHERE id = $1`,
      [storeId],
    );
    const store = storeRes.rows[0];
    if (!store || store.organization_id !== payload.orgId || store.status !== 'ACTIVE') {
      throw new ApiError('UNAUTHORIZED_SCOPE', 'Store is not available to this principal.');
    }

    let perms;
    try {
      perms = await this.auth.effectivePermissions(payload.sub, storeId);
    } catch (err) {
      if (err instanceof ApiError) {
        await this.auditDeny(req, storeId, err.code);
      }
      throw err;
    }
    req.authStoreId = storeId;
    req.actorEmployeeId = perms.employeeId;
    req.permissionCodes = perms.permissions;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [handler, cls]);
    if (required && required.length > 0) {
      const held = new Set(perms.permissions);
      const missing = required.filter((c) => !held.has(c));
      if (missing.length > 0) {
        await this.auditDeny(req, storeId, 'FORBIDDEN');
        throw new ApiError('FORBIDDEN', `Missing permission: ${missing.join(', ')}.`);
      }
    }
    return true;
  }

  private async auditDeny(req: FastifyRequest, storeId: string, reason: string): Promise<void> {
    try {
      await this.audit.security({
        organizationId: req.principal?.orgId,
        storeId,
        eventType: 'AUTHZ_DENIED',
        actorHint: req.principal?.username ?? '-',
        ip: req.ip ?? undefined,
        metadata: { reason, url: req.url },
      });
    } catch {
      // security logging must never break the rejection path
    }
  }
}
