/**
 * Preview seed — migrates the persistent preview database and inserts a
 * demonstration tenant (rooms, technicians, catalog, users). Prints the
 * org code + accounts for the FrontDesk login screen.
 */
import { createPool, Migrator } from '@lanxu/db';
import { seedTenant } from '@lanxu/testkit';

const url =
  process.env.DATABASE_URL ?? 'postgresql://lanxu:lanxu_preview_password@127.0.0.1:5433/lanxu';

async function main(): Promise<void> {
  const pool = createPool(url, { max: 4 });
  await new Migrator(pool).up();
  const t = await seedTenant(pool);
  await pool.end();

  console.log(
    JSON.stringify(
      {
        orgCode: t.orgCode,
        stores: { S01: t.storeA, S02: t.storeB },
        login: {
          boss: t.bossUsername,
          clerk: t.clerkUsername,
          aide: t.aideUsername,
          password: t.password,
        },
        rooms: {
          R101: t.roomClean1,
          R102: t.roomClean2,
          R103: t.roomDirty,
          B101: t.roomOtherStore,
        },
        technicians: [t.tech1, t.tech2, t.tech3, t.tech4],
        variants: { V90: t.serviceVariantId, V60: t.serviceVariantId2 },
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error('preview seed failed', err);
  process.exit(1);
});
