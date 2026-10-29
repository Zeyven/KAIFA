/**
 * Preview database keeper — boots ONE persistent embedded PostgreSQL 18
 * cluster for the live demo stack (dev/preview only; tests use throwaway
 * harness clusters). Data lives in .pgdata-preview (gitignored).
 */
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.PREVIEW_PG_PORT ?? 5433);
const db = new EmbeddedPostgres({
  databaseDir: '.pgdata-preview',
  user: 'lanxu',
  password: 'lanxu_preview_password',
  port,
  persistent: true,
});

const fresh = process.env.PREVIEW_PG_FRESH === '1';
if (fresh) {
  await db.initialise();
} else {
  // initialise is idempotent-safe only on empty dirs; ignore "exists"
  try {
    await db.initialise();
  } catch (err) {
    if (!String(err).includes('already exists') && !String(err).includes('exists')) throw err;
  }
}
await db.start();
try {
  await db.createDatabase('lanxu');
} catch (err) {
  if (!String(err).includes('already exists') && !String(err).includes('duplicate')) throw err;
}
console.log(`preview postgres ready on 127.0.0.1:${port} (db=lanxu)`);

// keep the process alive
process.on('SIGTERM', async () => {
  await db.stop();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
