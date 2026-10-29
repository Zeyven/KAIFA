/** Request-scoped identity shared by guards/services (fastify augmentation below). */

export interface Principal {
  userId: string;
  orgId: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the global auth guard after JWT verification. */
    principal?: Principal;
    /** Validated X-Store-Id (org + employment checked server-side). */
    authStoreId?: string;
    /** Employee id acting within authStoreId (audit actor). */
    actorEmployeeId?: string;
    /** Effective permission codes loaded for authStoreId (null when not loaded). */
    permissionCodes?: string[] | null;
  }
}

/** Actor shape written to audit_logs by every command service. */
export interface AuditActor {
  actorType: 'USER' | 'EMPLOYEE' | 'DEVICE' | 'SYSTEM';
  actorId?: string;
  requestId?: string;
  ip?: string;
}
