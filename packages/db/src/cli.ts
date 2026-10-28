#!/usr/bin/env node
import { loadEnv } from '@lanxu/config';
import { createPool, Migrator, MigrationError } from './index';

/** CLI: node dist/cli.js <up|status|down|verify> [steps] — DATABASE_URL required. */
async function main(): Promise<void> {
  const [command = 'status', arg] = process.argv.slice(2);
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required for migrations');
    process.exit(2);
  }
  const pool = createPool(env.DATABASE_URL, { max: 2, application_name: 'lanxu-migrate' });
  const migrator = new Migrator(pool);
  try {
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
        break;
      }
      case 'status': {
        const { applied, pending } = await migrator.status();
        console.log(`applied (${applied.length}): ${applied.map((a) => a.name).join(', ') || '-'}`);
        console.log(`pending (${pending.length}): ${pending.map((p) => p.name).join(', ') || '-'}`);
        break;
      }
      case 'down': {
        const steps = Number(arg ?? '1');
        const reverted = await migrator.down(steps);
        console.log(`reverted: ${reverted.join(', ')}`);
        break;
      }
      case 'verify': {
        await migrator.verifyChecksums();
        const current = await migrator.isCurrent();
        console.log(current ? 'migrations current, checksums OK' : 'PENDING migrations exist');
        process.exit(current ? 0 : 1);
        break;
      }
      default:
        console.error(`unknown command: ${command} (use up|status|down|verify)`);
        process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof MigrationError ? err.message : String(err);
  console.error(`migration error: ${message}`);
  process.exit(1);
});
