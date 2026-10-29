import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { redactForLog } from '@lanxu/observability';
import type { AuditActor } from '../common/http-context';
import { PG_POOL, requirePool } from '../db/pg.module';

export interface AuditRow {
  organizationId?: string;
  storeId?: string;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string;
}

/**
 * Audit writer (spec §16.1, invariant I24): MUST be called with the SAME
 * client/transaction as the mutation it describes. Rows are append-only at DB
 * level (trigger) — the app role cannot rewrite history (I25).
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}

  async record(client: PoolClient, row: AuditRow): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO audit_logs
         (organization_id, store_id, actor_type, actor_id, action, resource_type,
          resource_id, request_id, before, after, reason, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
       RETURNING id`,
      [
        row.organizationId ?? null,
        row.storeId ?? null,
        row.actor.actorType,
        row.actor.actorId ?? null,
        row.action,
        row.resourceType,
        row.resourceId ?? null,
        row.actor.requestId ?? null,
        row.before ? JSON.stringify(redactForLog(row.before)) : null,
        row.after ? JSON.stringify(redactForLog(row.after)) : null,
        row.reason ?? null,
        row.actor.ip ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /** Security event (login failures, denials) — own append-only table. */
  async security(
    event: {
      organizationId?: string;
      storeId?: string;
      eventType: string;
      actorHint?: string;
      ip?: string;
      metadata?: Record<string, unknown>;
    },
    client: PoolClient | Pool | null = null,
  ): Promise<void> {
    const runner = client ?? requirePool(this.pool);
    await runner.query(
      `INSERT INTO security_events (organization_id, store_id, event_type, actor_hint, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        event.organizationId ?? null,
        event.storeId ?? null,
        event.eventType,
        event.actorHint ?? null,
        event.ip ?? null,
        JSON.stringify(redactForLog(event.metadata ?? {})),
      ],
    );
  }
}
