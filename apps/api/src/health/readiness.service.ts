import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type AppEnv } from '@lanxu/config';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { ENV } from '../env/env.module';

/** DI token for readiness checking. */
export const READINESS = 'LANXU_READINESS';

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: Record<string, string>;
}

/**
 * `/health/ready` semantics (spec §16.3): ready means we can ACTUALLY serve —
 * DB reachable AND migrations current AND checksums intact. Configured with no
 * DATABASE_URL we are honestly not_ready (fail closed), never fake-green.
 */
@Injectable()
export class ReadinessService implements OnModuleDestroy {
  private pool: Pool | null = null;

  constructor(@Inject(ENV) private readonly env: AppEnv) {}

  private getPool(): Pool {
    if (!this.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    this.pool ??= createPool(this.env.DATABASE_URL, {
      max: 2,
      application_name: 'lanxu-api-ready',
    });
    return this.pool;
  }

  async check(): Promise<ReadinessResult> {
    if (!this.env.DATABASE_URL) {
      return { status: 'not_ready', checks: { db: 'not_configured' } };
    }
    try {
      await this.getPool().query('SELECT 1');
    } catch {
      return { status: 'not_ready', checks: { db: 'unreachable' } };
    }
    try {
      const current = await new Migrator(this.getPool()).isCurrent();
      if (!current) {
        return { status: 'not_ready', checks: { db: 'ok', migrations: 'pending' } };
      }
    } catch {
      // includes checksum tamper (MigrationError) — fail closed
      return { status: 'not_ready', checks: { db: 'ok', migrations: 'invalid' } };
    }
    return { status: 'ready', checks: { db: 'ok', migrations: 'ok' } };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
}
