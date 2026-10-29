import { Inject, Injectable } from '@nestjs/common';
import { type AppEnv } from '@lanxu/config';
import { Migrator, type Pool } from '@lanxu/db';
import { ENV } from '../env/env.module';
import { PG_POOL } from '../db/pg.module';

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
export class ReadinessService {
  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(PG_POOL) private readonly pool: Pool | null,
  ) {}

  private getPool(): Pool {
    if (!this.env.DATABASE_URL || !this.pool) {
      throw new Error('DATABASE_URL not configured');
    }
    return this.pool;
  }

  async check(): Promise<ReadinessResult> {
    if (!this.env.DATABASE_URL || !this.pool) {
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
}
