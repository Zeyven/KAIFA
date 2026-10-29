import { execSync, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { startPgHarness, seedTenant, type PgHarness, type TenantFixture } from '@lanxu/testkit';

/**
 * Phase 07 vertical-slice E2E (browserless): real PG18 + real Nest API +
 * real Next dev server, traffic flowing browser-style through the Next
 * proxy (relative /api/v1/* → API). Proves login → rooms read → command
 * write-through → re-read, plus the frozen error envelope.
 */

const API_PORT = 4171;
const WEB_PORT = 4172;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const ROOT = path.resolve(import.meta.dirname, '../../..');

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not up in ${timeoutMs}ms`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    if (Date.now() > deadline) throw new Error(`${url} not ready in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

describe('FrontDesk vertical slice (Next proxy → API → PG)', () => {
  let harness: PgHarness;
  let db: Pool;
  let t: TenantFixture;
  let apiProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;
  let token = '';

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-e2e-');
    db = createPool(harness.connectionString, { max: 4 });
    await new Migrator(db).up();
    t = await seedTenant(db);

    // guarantee fresh API dist (also run by `verify` typecheck, but standalone
    // integration runs must not boot a stale binary)
    execSync('npx tsc -b', { cwd: ROOT, stdio: 'ignore' });

    apiProc = spawn(process.execPath, [path.join(ROOT, 'apps/api/dist/main.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        LOG_LEVEL: 'fatal',
        DATABASE_URL: harness.connectionString,
        JWT_SECRET: 'e'.repeat(48),
        JWT_ACCESS_TTL_SECONDS: '3600',
        PAYMENT_PROVIDER: 'fake',
      },
      stdio: 'ignore',
    });
    await waitForHttpOk(`${API}/health/ready`, 30_000);

    webProc = spawn(
      path.join(ROOT, 'node_modules/.bin/next'),
      ['dev', '-H', '127.0.0.1', '-p', String(WEB_PORT)],
      {
        cwd: path.join(ROOT, 'apps/web'),
        env: { ...process.env, API_PROXY_TARGET: API, NODE_ENV: 'development' },
        stdio: 'ignore',
      },
    );
    await waitForPort(WEB_PORT, 60_000);
    await waitForHttpOk(`${WEB}/login`, 60_000);
  }, 150_000);

  afterAll(async () => {
    webProc?.kill('SIGTERM');
    apiProc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    webProc?.kill('SIGKILL');
    apiProc?.kill('SIGKILL');
    await db?.end();
    await harness?.stop();
  });

  it('GET /login renders the zh-CN login page (SSR)', async () => {
    const res = await fetch(`${WEB}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('门店登录');
    expect(html).toContain('LanXu StoreOS');
  });

  it('POST /api/v1/auth/login through the Next proxy returns a token', async () => {
    const res = await fetch(`${WEB}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgCode: t.orgCode,
        username: t.bossUsername,
        password: t.password,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { token: string; stores: Array<{ id: string }> };
    };
    expect(body.data.token).toBeTruthy();
    expect(body.data.stores[0]!.id).toBe(t.storeA);
    token = body.data.token;
  });

  it('GET /api/v1/rooms through the proxy returns the seeded board', async () => {
    const res = await fetch(`${WEB}/api/v1/rooms`, {
      headers: { authorization: `Bearer ${token}`, 'x-store-id': t.storeA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ code: string }> } };
    const codes = body.data.items.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['R101', 'R102', 'R103']));
  });

  it('command write-through: open room via proxy → board state changes', async () => {
    const open = await fetch(`${WEB}/api/v1/rooms/${t.roomClean1}/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-store-id': t.storeA,
      },
      body: JSON.stringify({ guestCount: 2 }),
    });
    expect(open.status).toBe(201);

    const after = await fetch(`${WEB}/api/v1/rooms/${t.roomClean1}`, {
      headers: { authorization: `Bearer ${token}`, 'x-store-id': t.storeA },
    });
    const body = (await after.json()) as { data: { operational_state: string } };
    expect(body.data.operational_state).toBe('OCCUPIED_WAITING_SERVICE');
  });

  it('clock-board reads through the proxy: variants + queue + recommend', async () => {
    const auth = {
      authorization: `Bearer ${token}`,
      'x-store-id': t.storeA,
      'content-type': 'application/json',
    };
    const variants = await fetch(`${WEB}/api/v1/service-variants`, { headers: auth });
    expect(variants.status).toBe(200);
    const vBody = (await variants.json()) as { data: { items: Array<{ code: string }> } };
    expect(vBody.data.items.map((v) => v.code)).toEqual(expect.arrayContaining(['V90', 'V60']));

    const queue = await fetch(`${WEB}/api/v1/scheduling/queue`, { headers: auth });
    expect(queue.status).toBe(200);

    // clock-in one technician so recommend has a candidate (real flow)
    const clock = await fetch(`${WEB}/api/v1/technicians/${t.tech1}/clock-in`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    expect(clock.status).toBe(201);
    const rec = await fetch(`${WEB}/api/v1/scheduling/recommend`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(rec.status).toBe(201);
    const rBody = (await rec.json()) as {
      data: {
        selected?: { technicianId: string };
        weights: Record<string, number>;
        policy: string;
      };
    };
    expect(rBody.data.selected?.technicianId).toBe(t.tech1);
    expect(rBody.data.policy).toContain('BUSINESS POLICY');

    const sessions = await fetch(`${WEB}/api/v1/service-sessions?today=1`, { headers: auth });
    expect(sessions.status).toBe(200);
  });

  it('error envelope survives the proxy (401 without token)', async () => {
    const res = await fetch(`${WEB}/api/v1/rooms`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.message).toBeTruthy();
  });
});
