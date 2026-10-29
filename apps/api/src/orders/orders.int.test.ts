/**
 * Phase 11 Order Engine (spec §4.7 tables, §5.4 machine, §9.4 math, invariants
 * #7 数学对账 / #11 成交快照 / §22.1 double-billing blocker). Real PostgreSQL.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { hashPassword } from '@lanxu/domain';
import { startPgHarness, seedTenant, type PgHarness, type TenantFixture } from '@lanxu/testkit';
import { apiSuccessSchema } from '@lanxu/contracts';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { configureApi } from '../setup';

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
}

interface OrderData {
  id: string;
  status: string;
  visit_id: string;
  subtotal_cents: number | string;
  discount_cents: number | string;
  payable_cents: number | string;
  paid_cents: number | string;
  version: number;
  items?: Array<{
    id: string;
    item_type: string;
    name_snapshot: string;
    unit_price_cents: number | string;
    gross_cents: number | string;
    net_cents: number | string;
    service_session_id: string | null;
    status: string;
  }>;
  adjustments?: unknown[];
  activeSessionCount?: number;
}

describe('order engine (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let t: TenantFixture;
  let bossToken = '';
  let clerkToken = '';
  let clockroomToken = '';

  async function call(
    opts: InjectOpts,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.storeId) headers['x-store-id'] = opts.storeId;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: opts.method ?? 'GET',
        url: opts.url,
        headers,
        ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
      });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
  }

  async function login(
    username: string,
    orgCode = t.orgCode,
    password = t.password,
  ): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/v1/auth/login',
      body: { orgCode, username, password },
    });
    expect(res.status).toBe(200);
    return (res.body.data as { token: string }).token;
  }

  function data<T>(res: { body: Record<string, unknown> }): T {
    return res.body.data as T;
  }

  const boss = (url: string, body?: unknown, method: 'GET' | 'POST' = 'GET') =>
    call({
      url,
      method,
      token: bossToken,
      storeId: t.storeA,
      ...(body !== undefined ? { body } : {}),
    });

  // shared linear state
  let visit1 = '';
  let visit2 = '';
  let order1 = '';
  let order2 = '';
  let sessionId = '';

  const openVisit = async (roomId: string): Promise<string> => {
    const res = await boss(`/v1/rooms/${roomId}/open`, { guestCount: 2 }, 'POST');
    expect(res.status).toBe(201);
    return data<{ visitId: string }>(res).visitId;
  };

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-ord-');
    const raw = createPool(harness.connectionString, { max: 4 });
    await new Migrator(raw).up();
    t = await seedTenant(raw);
    db = raw;

    // inline clockroom user (has schedule rights, NO order.discount → 403 case)
    const passwordHash = await hashPassword(t.password);
    const c = await raw.query<{ user_id: string }>(
      `WITH u AS (
         INSERT INTO users (organization_id, username, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE') RETURNING id
       ), e AS (
         INSERT INTO employees (organization_id, store_id, user_id, employee_no, display_name, employee_type)
         SELECT $1, $4, u.id, 'CK-001', '钟房测试', 'MANAGER' FROM u RETURNING id
       )
       SELECT u.id AS user_id FROM u`,
      [t.orgId, `clock_${t.orgCode.toLowerCase()}`, passwordHash, t.storeA],
    );
    await raw.query(
      `INSERT INTO employee_roles (employee_id, role_id, store_id)
       SELECT e.id, r.id, $2 FROM employees e, roles r
       WHERE e.user_id = $1 AND r.code = 'role.clockroom'`,
      [c.rows[0]!.user_id, t.storeA],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue({
        NODE_ENV: 'test',
        PORT: 4000,
        LOG_LEVEL: 'fatal',
        DATABASE_URL: harness.connectionString,
        JWT_SECRET: 'v'.repeat(48),
        JWT_ACCESS_TTL_SECONDS: 3600,
        PAYMENT_PROVIDER: 'fake',
        DISCOUNT_APPROVAL_THRESHOLD_CENTS: 10_000,
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(createFastifyOptions()),
    );
    configureApi(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    bossToken = await login(t.bossUsername);
    clerkToken = await login(t.clerkUsername);
    clockroomToken = await login(`clock_${t.orgCode.toLowerCase()}`);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('open: idempotent find-or-create per visit (partial unique), cross-store 404', async () => {
    visit1 = await openVisit(t.roomClean1);

    const first = await boss('/v1/orders/open', { visitId: visit1 }, 'POST');
    expect(first.status).toBe(201);
    apiSuccessSchema.parse(first.body);
    const o = data<OrderData>(first);
    expect(o.status).toBe('OPEN');
    order1 = o.id;

    const second = await boss('/v1/orders/open', { visitId: visit1 }, 'POST');
    expect(second.status).toBe(201);
    expect(data<OrderData>(second).id).toBe(order1); // converged, not forked

    // clerk IS employed at store B: scope passes, object-level lookup 404s
    const other = await call({
      url: '/v1/orders/open',
      method: 'POST',
      token: clerkToken,
      storeId: t.storeB,
      body: { visitId: visit1 }, // store A visit via store B scope → not found
    });
    expect(other.status).toBe(404);

    // one live order per visit — DB-level
    const { rows } = await db.query(
      `SELECT count(*) FROM orders WHERE visit_id = $1 AND status IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT')`,
      [visit1],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('items: server-priced snapshots; catalog drift never rewrites history (§4.7)', async () => {
    const add = await boss(
      `/v1/orders/${order1}/items`,
      { productId: t.productId, quantity: 2 },
      'POST',
    );
    expect(add.status).toBe(201);
    const updated = data<OrderData>(add);
    expect(Number(updated.subtotal_cents)).toBe(9800 * 2);
    expect(Number(updated.payable_cents)).toBe(19600);

    // client-supplied price is impossible: no price field exists on the body —
    // verify an unknown price is ignored and server price wins
    const sneaky = await boss(
      `/v1/orders/${order1}/items`,
      {
        productId: t.productId2,
        quantity: 1,
        unitPriceCents: 1,
      } as never,
      'POST',
    );
    expect(sneaky.status).toBe(201);
    expect(Number(data<OrderData>(sneaky).subtotal_cents)).toBe(19600 + 1500);

    // catalog price change must NOT touch the settled line
    await db.query(`UPDATE products SET list_price_cents = 999999 WHERE id = $1`, [t.productId]);
    const after = await boss(`/v1/orders/${order1}`);
    const line = data<OrderData>(after).items!.find((i) => i.item_type === 'PRODUCT')!;
    expect(Number(line.unit_price_cents)).toBe(9800);
    expect(line.name_snapshot).toBe('纯棉浴巾');
    await db.query(`UPDATE products SET list_price_cents = 9800 WHERE id = $1`, [t.productId]);
  });

  it('session lifecycle drives the order: auto-open → IN_SERVICE → billed snapshot', async () => {
    visit2 = await openVisit(t.roomClean2);

    // no explicit /orders/open — session create must ensure the bill exists
    await boss('/v1/technicians/' + t.tech1 + '/clock-in', {}, 'POST');
    const created = await boss(
      '/v1/service-sessions',
      { visitId: visit2, serviceVariantId: t.serviceVariantId, technicianId: t.tech1 },
      'POST',
    );
    expect(created.status).toBe(201);
    sessionId = data<{ sessionId: string }>(created).sessionId;

    const list = await boss(`/v1/orders?visitId=${visit2}`);
    const auto = data<{ items: OrderData[] }>(list).items;
    expect(auto).toHaveLength(1);
    expect(auto[0]!.status).toBe('OPEN');
    order2 = auto[0]!.id;

    const ack = await boss(`/v1/service-sessions/${sessionId}/acknowledge`, {}, 'POST');
    expect(ack.status).toBe(201);
    const arrive = await boss(`/v1/service-sessions/${sessionId}/arrive`, {}, 'POST');
    expect(arrive.status).toBe(201);
    const start = await boss(`/v1/service-sessions/${sessionId}/start`, {}, 'POST');
    expect(start.status).toBe(201);
    const inService = await boss(`/v1/orders/${order2}`);
    expect(data<OrderData>(inService).status).toBe('IN_SERVICE');

    const done = await boss(`/v1/service-sessions/${sessionId}/complete`, {}, 'POST');
    expect(done.status).toBe(201);
    const billed = data<OrderData>(await boss(`/v1/orders/${order2}`));
    expect(billed.status).toBe('IN_SERVICE'); // status stays; checkout flips it
    expect(Number(billed.subtotal_cents)).toBe(29800);
    const svc = billed.items!.find((i) => i.item_type === 'SERVICE')!;
    expect(svc.service_session_id).toBe(sessionId);
    expect(svc.name_snapshot).toContain('90分钟');
    expect(Number(svc.unit_price_cents)).toBe(29800);
    expect(billed.activeSessionCount).toBe(0);
  });

  it('double-billing blocker: a session can only have one ACTIVE line (23505)', async () => {
    const orderRow = await db.query<{ id: string }>(
      `SELECT order_id AS id FROM order_items WHERE service_session_id = $1`,
      [sessionId],
    );
    expect(orderRow.rows).toHaveLength(1);
    await expect(
      db.query(
        `INSERT INTO order_items (order_id, item_type, service_session_id, service_variant_id,
                                  name_snapshot, quantity, unit_price_cents, gross_cents, net_cents)
         VALUES ($1, 'SERVICE', $2, $3, 'dup', 1, 100, 100, 100)`,
        [orderRow.rows[0]!.id, sessionId, t.serviceVariantId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('discounts: cumulative threshold → APPROVAL_REQUIRED; adjustments append-only', async () => {
    const ok = await boss(
      `/v1/orders/${order1}/discounts`,
      { amountCents: 5000, reasonCode: 'PROMO' },
      'POST',
    );
    expect(ok.status).toBe(201);
    const discounted = data<OrderData>(ok);
    expect(Number(discounted.discount_cents)).toBe(5000);
    expect(Number(discounted.payable_cents)).toBe(Number(discounted.subtotal_cents) - 5000);

    // cumulative 11000 > 10000 threshold → fail closed (approval lands Phase 23)
    const over = await boss(`/v1/orders/${order1}/discounts`, { amountCents: 6000 }, 'POST');
    expect(over.status).toBe(422);
    expect((over.body as { error: { code: string } }).error.code).toBe('APPROVAL_REQUIRED');

    // clockroom has order.read but NOT order.discount → 403
    const forbidden = await call({
      url: `/v1/orders/${order1}/discounts`,
      method: 'POST',
      token: clockroomToken,
      storeId: t.storeA,
      body: { amountCents: 100 },
    });
    expect(forbidden.status).toBe(403);

    // append-only history
    await expect(
      db.query(`UPDATE order_adjustments SET amount_cents = 1 WHERE order_id = $1`, [order1]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db.query(`DELETE FROM order_adjustments WHERE order_id = $1`, [order1]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('checkout: refuses active service, freezes totals, blocks further items, idempotent', async () => {
    // new running session on visit1 blocks checkout
    await boss(
      '/v1/service-sessions',
      { visitId: visit1, serviceVariantId: t.serviceVariantId2 },
      'POST',
    );
    const blocked = await boss(`/v1/orders/${order1}/checkout`, {}, 'POST');
    expect(blocked.status).toBe(422);
    expect((blocked.body as { error: { code: string } }).error.code).toBe(
      'ORDER_HAS_ACTIVE_SERVICE',
    );

    // cancel that draft session (DRAFT → CANCEL) so the visit is settled
    const { rows: draft } = await db.query<{ id: string }>(
      `SELECT id FROM service_sessions WHERE visit_id = $1 AND status = 'DRAFT'`,
      [visit1],
    );
    expect(draft.length).toBeGreaterThanOrEqual(1);
    for (const d of draft) {
      const res = await boss(`/v1/service-sessions/${d.id}/cancel`, {}, 'POST');
      expect(res.status).toBe(201);
    }

    const checkout = await boss(`/v1/orders/${order1}/checkout`, {}, 'POST');
    expect(checkout.status).toBe(201);
    const frozen = data<OrderData>(checkout);
    expect(frozen.status).toBe('PENDING_CHECKOUT');
    expect(Number(frozen.payable_cents)).toBe(
      Number(frozen.subtotal_cents) - Number(frozen.discount_cents),
    );
    expect(Number(frozen.paid_cents)).toBe(0);

    // frozen bill rejects new items
    const late = await boss(`/v1/orders/${order1}/items`, { productId: t.productId2 }, 'POST');
    expect(late.status).toBe(422);

    // idempotent re-freeze
    const again = await boss(`/v1/orders/${order1}/checkout`, {}, 'POST');
    expect(again.status).toBe(201);
    expect(data<OrderData>(again).version).toBe(frozen.version);

    // version OCC
    const stale = await boss(`/v1/orders/${order1}/checkout`, { expectedVersion: 1 }, 'POST');
    expect(stale.status).toBe(409);
  });

  it('outbox: order.updated events carry monotonic storeSeq in the same tx', async () => {
    const { rows } = await db.query<{ store_seq: string; payload: { reason?: string } }>(
      `SELECT store_seq, payload FROM outbox_events
       WHERE store_id = $1 AND event_type = 'order.updated'
       ORDER BY store_seq`,
      [t.storeA],
    );
    expect(rows.length).toBeGreaterThanOrEqual(4); // opened/discount/…/checkout
    const seqs = rows.map((r) => Number(r.store_seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const reasons = rows.map((r) => r.payload.reason);
    expect(reasons).toEqual(expect.arrayContaining(['opened', 'checkout_started']));
  });

  it('object-level: cross-store reads 404; store B list stays empty', async () => {
    const cross = await call({ url: `/v1/orders/${order1}`, token: clerkToken, storeId: t.storeB });
    expect(cross.status).toBe(404);

    const listB = await call({ url: '/v1/orders', token: clerkToken, storeId: t.storeB });
    expect(listB.status).toBe(200);
    expect(data<{ items: unknown[] }>(listB).items).toHaveLength(0);

    const listA = await boss('/v1/orders');
    const items = data<{ items: OrderData[] }>(listA).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.map((o) => o.id)).toEqual(expect.arrayContaining([order1, order2]));

    const today = await boss('/v1/orders?today=1');
    expect(data<{ items: unknown[] }>(today).items.length).toBeGreaterThanOrEqual(2);
  });
});
