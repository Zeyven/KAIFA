/**
 * Phase 12 — Cash payment + till reconciliation (spec §13.1, §5.4 payment
 * machine, §20 invariants #3/#4/#7). Real PostgreSQL.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, Migrator, type Pool } from '@lanxu/db';
import { startPgHarness, seedTenant, type PgHarness, type TenantFixture } from '@lanxu/testkit';
import { AppModule } from '../app.module';
import { ENV } from '../env/env.module';
import { createFastifyOptions } from '../common/fastify-options';
import { webhookSignature } from './provider';
import { configureApi } from '../setup';

interface InjectOpts {
  url: string;
  method?: 'GET' | 'POST';
  token?: string;
  storeId?: string;
  body?: unknown;
  idempotencyKey?: string;
}

describe('cash payments + cash sessions (integration)', () => {
  let harness: PgHarness;
  let app: NestFastifyApplication;
  let db: Pool;
  let t: TenantFixture;
  let bossToken = '';
  let clerkToken = '';

  async function call(
    opts: InjectOpts,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.storeId) headers['x-store-id'] = opts.storeId;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
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

  const boss = (url: string, body?: unknown, method: 'GET' | 'POST' = 'GET', key?: string) =>
    call({
      url,
      method,
      token: bossToken,
      storeId: t.storeA,
      ...(body !== undefined ? { body } : {}),
      ...(key ? { idempotencyKey: key } : {}),
    });

  let orderA = ''; // paid flow
  let orderB = ''; // till-closed flow
  let orderC = ''; // not-checked-out flow
  let till = '';

  const makeCheckoutOrder = async (room: string, quantity = 1): Promise<string> => {
    const open = await boss(`/v1/rooms/${room}/open`, { guestCount: 1 }, 'POST');
    expect(open.status).toBe(201);
    const visitId = data<{ visitId: string }>(open).visitId;
    const ord = await boss('/v1/orders/open', { visitId }, 'POST');
    expect(ord.status).toBe(201);
    const orderId = data<{ id: string }>(ord).id;
    const item = await boss(
      `/v1/orders/${orderId}/items`,
      { productId: t.productId2, quantity },
      'POST',
    );
    expect(item.status).toBe(201);
    const co = await boss(`/v1/orders/${orderId}/checkout`, {}, 'POST');
    expect(co.status).toBe(201);
    return orderId;
  };

  beforeAll(async () => {
    harness = await startPgHarness('lanxu-pg-pay-');
    const raw = createPool(harness.connectionString, { max: 4 });
    await new Migrator(raw).up();
    t = await seedTenant(raw);
    db = raw;

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
        PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-test-webhook-123',
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await harness?.stop();
  });

  it('cash session: open is idempotent find-or-open (one OPEN till per store)', async () => {
    const first = await boss('/v1/cash-sessions', { openingFloatCents: 20000 }, 'POST');
    expect(first.status).toBe(201);
    const created = data<{ id: string; status: string; opening_float_cents: number | string }>(
      first,
    );
    expect(created.status).toBe('OPEN');
    expect(Number(created.opening_float_cents)).toBe(20000);
    till = created.id;

    const second = await boss('/v1/cash-sessions', { openingFloatCents: 999 }, 'POST');
    expect(second.status).toBe(201);
    expect(data<{ id: string }>(second).id).toBe(till); // returned existing, float NOT overwritten

    const { rows } = await db.query(
      `SELECT count(*) FROM cash_sessions WHERE store_id = $1 AND status = 'OPEN'`,
      [t.storeA],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('create: Idempotency-Key mandatory; replay returns same result; payload mismatch 409', async () => {
    orderA = await makeCheckoutOrder(t.roomClean1, 4); // due = 6000

    const noKey = await boss(
      '/v1/payments',
      { orderId: orderA, method: 'CASH', amountCents: 1500 },
      'POST',
    );
    expect(noKey.status).toBe(400);
    expect((noKey.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');

    const first = await boss(
      '/v1/payments',
      { orderId: orderA, method: 'CASH', amountCents: 1500 },
      'POST',
      'pay-key-001',
    );
    expect(first.status).toBe(201);
    const p = data<{ id: string; status: string; replayed: boolean }>(first);
    expect(p.status).toBe('CREATED');
    expect(p.replayed).toBe(false);

    const replay = await boss(
      '/v1/payments',
      { orderId: orderA, method: 'CASH', amountCents: 1500 },
      'POST',
      'pay-key-001',
    );
    expect(replay.status).toBe(201);
    const again = data<{ id: string; replayed: boolean }>(replay);
    expect(again.id).toBe(p.id);
    expect(again.replayed).toBe(true);

    const conflict = await boss(
      '/v1/payments',
      { orderId: orderA, method: 'CASH', amountCents: 999 },
      'POST',
      'pay-key-001',
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('create guards: order must be checked out; amount ≤ due; till must exist', async () => {
    // golden path: a DIRTY room must be cleaned before a visit opens (§5.1)
    const cs = await boss(`/v1/rooms/${t.roomDirty}/cleaning/start`, {}, 'POST');
    expect(cs.status).toBe(201);
    const cc = await boss(
      `/v1/rooms/${t.roomDirty}/cleaning/complete`,
      { checklistPassed: true },
      'POST',
    );
    expect(cc.status).toBe(201);
    orderC = await makeCheckoutOrder(t.roomDirty);
    // amount above the remaining due
    const over = await boss(
      '/v1/payments',
      { orderId: orderA, method: 'CASH', amountCents: 999999 },
      'POST',
      'pay-over-1',
    );
    expect(over.status).toBe(422);
    expect((over.body as { error: { code: string } }).error.code).toBe('PAYMENT_EXCEEDS_DUE');

    // Phase 13: online methods create SERVER-side provider orders → PENDING
    // (target orderC — this test's own order — so orderA stays cash-only)
    const online = await boss(
      '/v1/payments',
      { orderId: orderC, method: 'WECHAT', amountCents: 100 },
      'POST',
      'pay-online-1',
    );
    expect(online.status).toBe(201);
    const onlineData = data<{ status: string; providerPayload: { qr: string } }>(online);
    expect(onlineData.status).toBe('PENDING');
    expect(onlineData.providerPayload.qr).toContain('fakepay://');

    // capture-time exceed: partial leaves 500 due → raw 999999 must fail 422
    const cPay = await boss(
      '/v1/payments',
      { orderId: orderC, method: 'CASH', amountCents: 1000 },
      'POST',
      'pay-c-1',
    );
    expect(cPay.status).toBe(201);
    const cCap = await boss(`/v1/payments/${data<{ id: string }>(cPay).id}/capture`, {}, 'POST');
    expect(cCap.status).toBe(201);
    expect(data<{ order: { status: string } }>(cCap).order.status).toBe('PARTIALLY_PAID');
    const rawOver = await db.query<{ id: string }>(
      `INSERT INTO payments (store_id, order_id, cash_session_id, method, provider, amount_cents, idempotency_key)
       SELECT store_id, id, $2, 'CASH', 'cash', 999999, 'raw-overpay-c' FROM orders WHERE id = $1
       RETURNING id`,
      [orderC, till],
    );
    const overCap = await boss(`/v1/payments/${rawOver.rows[0]!.id}/capture`, {}, 'POST');
    expect(overCap.status).toBe(422);
    expect((overCap.body as { error: { code: string } }).error.code).toBe('PAYMENT_EXCEEDS_DUE');
  });

  it('capture: CREATED→CAPTURED updates order in the same tx; partial then PAID', async () => {
    const listBefore = await db.query<{ id: string; amount_cents: string }>(
      `SELECT id, amount_cents FROM payments WHERE order_id = $1`,
      [orderA],
    );
    expect(listBefore.rows).toHaveLength(1);
    const payId = listBefore.rows[0]!.id;

    // pay only part of the 6000 due (full split tender lands Phase 13)
    const partial = await boss(`/v1/payments/${payId}/capture`, {}, 'POST');
    expect(partial.status).toBe(201);
    const cap = data<{ status: string; order: { status: string; paid_cents: number | string } }>(
      partial,
    );
    expect(cap.status).toBe('CAPTURED');
    expect(cap.order.status).toBe('PARTIALLY_PAID');
    expect(Number(cap.order.paid_cents)).toBe(1500);

    // second cash payment closes the bill
    const second = await boss(
      '/v1/payments',
      { orderId: orderA, method: 'CASH', amountCents: 4500 },
      'POST',
      'pay-key-002',
    );
    expect(second.status).toBe(201);
    const p2 = data<{ id: string }>(second);
    const done = await boss(`/v1/payments/${p2.id}/capture`, {}, 'POST');
    expect(done.status).toBe(201);
    const final = data<{ status: string; order: { status: string; paid_cents: number | string } }>(
      done,
    );
    expect(final.order.status).toBe('PAID');
    expect(Number(final.order.paid_cents)).toBe(6000);

    // double-capture is idempotent, not a double-post
    const again = await boss(`/v1/payments/${payId}/capture`, {}, 'POST');
    expect(again.status).toBe(201);
    expect(data<{ replayed: boolean }>(again).replayed).toBe(true);

    // golden path settle: visit CLOSED + room ORDER_PAID → DIRTY (§5.1)
    const settle = await db.query<{ visit_status: string; operational_state: string }>(
      `SELECT v.status AS visit_status, r.operational_state
       FROM visits v JOIN rooms r ON r.id = v.room_id
       WHERE v.id = (SELECT visit_id FROM orders WHERE id = $1)`,
      [orderA],
    );
    expect(settle.rows[0]!.visit_status).toBe('CLOSED');
    expect(settle.rows[0]!.operational_state).toBe('DIRTY');
    const { rows: evs } = await db.query(
      `SELECT 1 FROM outbox_events
       WHERE store_id = $1 AND event_type = 'visit.closed' AND (payload->>'orderId') = $2`,
      [t.storeA, orderA],
    );
    expect(evs).toHaveLength(1);
    // cleaning cycle returns the room to service
    const clean1 = await boss(`/v1/rooms/${t.roomClean1}/cleaning/start`, {}, 'POST');
    expect(clean1.status).toBe(201);
    const clean2 = await boss(
      `/v1/rooms/${t.roomClean1}/cleaning/complete`,
      { checklistPassed: true },
      'POST',
    );
    expect(clean2.status).toBe(201);
    const roomState = await db.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1`,
      [t.roomClean1],
    );
    expect(roomState.rows[0]!.operational_state).toBe('VACANT_CLEAN');
  });

  it('events: payment.updated + order.paid emitted transactionally with monotonic seq', async () => {
    const { rows } = await db.query<{ event_type: string; store_seq: string }>(
      `SELECT event_type, store_seq FROM outbox_events
       WHERE store_id = $1 AND event_type IN ('payment.updated','order.paid')
       ORDER BY store_seq`,
      [t.storeA],
    );
    const types = rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['payment.updated', 'order.paid']));
    const seqs = rows.map((r) => Number(r.store_seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('captured rows are immutable (23001): no amount edits, no status reverts, no deletes', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE status = 'CAPTURED' LIMIT 1`,
    );
    const id = rows[0]!.id;
    await expect(
      db.query(`UPDATE payments SET amount_cents = 1 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(db.query(`DELETE FROM payments WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('reconciliation: close computes expected = float + captured, variance exact', async () => {
    // second till lifecycle for store A happens after first is still OPEN —
    // close the shared till with a deliberate shortage
    const cashCaptured = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments
       WHERE cash_session_id = $1 AND status = 'CAPTURED' AND method = 'CASH'`,
      [till],
    );
    const expected = 20000 + Number(cashCaptured.rows[0]!.total);
    const counted = expected - 300; // ¥3 shortage
    const close = await boss(
      `/v1/cash-sessions/${till}/close`,
      { countedCashCents: counted },
      'POST',
    );
    expect(close.status).toBe(201);
    const closed = data<{
      status: string;
      expected_cash_cents: number | string;
      counted_cash_cents: number | string;
      variance_cents: number | string;
    }>(close);
    expect(closed.status).toBe('CLOSED');
    expect(Number(closed.expected_cash_cents)).toBe(expected);
    expect(Number(closed.counted_cash_cents)).toBe(counted);
    expect(Number(closed.variance_cents)).toBe(-300);

    // already closed → 422; capture without OPEN till → CASH_SESSION_REQUIRED
    const again = await boss(`/v1/cash-sessions/${till}/close`, { countedCashCents: 0 }, 'POST');
    expect(again.status).toBe(422);

    orderB = await makeCheckoutOrder(t.roomClean2);
    const orphan = await boss(
      '/v1/payments',
      { orderId: orderB, method: 'CASH', amountCents: 1500 },
      'POST',
      'pay-key-orphan',
    );
    expect(orphan.status).toBe(422);
    expect((orphan.body as { error: { code: string } }).error.code).toBe('CASH_SESSION_REQUIRED');
  });

  it('object-level: cross-store payment reads 404; store-scoped till list', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE store_id = $1 LIMIT 1`,
      [t.storeA],
    );
    const cross = await call({
      url: `/v1/payments/${rows[0]!.id}`,
      token: clerkToken,
      storeId: t.storeB,
    });
    expect(cross.status).toBe(404);

    const listB = await call({ url: '/v1/cash-sessions', token: clerkToken, storeId: t.storeB });
    expect(listB.status).toBe(200);
    expect(data<{ items: unknown[] }>(listB).items).toHaveLength(0);
  });

  it('split tender (§9.4): cash + wechat verify + alipay webhook → one PAID order', async () => {
    // till was closed by the reconciliation test — find-or-open a fresh one
    const tillOpen = await boss('/v1/cash-sessions', {}, 'POST');
    expect(tillOpen.status).toBe(201);

    // roomClean1 is VACANT_CLEAN after the golden-path test above
    const orderId = await makeCheckoutOrder(t.roomClean1); // payable = 1500 (drink line)

    // 1) CASH 300 captured immediately
    const c1 = await boss(
      '/v1/payments',
      { orderId, method: 'CASH', amountCents: 300 },
      'POST',
      'mix-cash-1',
    );
    expect(c1.status).toBe(201);
    const c1cap = await boss(`/v1/payments/${data<{ id: string }>(c1).id}/capture`, {}, 'POST');
    expect(c1cap.status).toBe(201);

    // 2) WECHAT 500 → PENDING; cashier capture refused (server verify only)
    const w1 = await boss(
      '/v1/payments',
      { orderId, method: 'WECHAT', amountCents: 500 },
      'POST',
      'mix-wechat-1',
    );
    expect(w1.status).toBe(201);
    const w1data = data<{ id: string; status: string; providerPayload: { qr: string } }>(w1);
    expect(w1data.status).toBe('PENDING');
    expect(w1data.providerPayload.qr).toContain('fakepay://');
    const w1cap = await boss(`/v1/payments/${w1data.id}/capture`, {}, 'POST');
    expect(w1cap.status).toBe(422);
    expect((w1cap.body as { error: { code: string } }).error.code).toBe('INVALID_STATE_TRANSITION');

    const w1verify = await boss(`/v1/payments/${w1data.id}/verify`, {}, 'POST');
    expect(w1verify.status).toBe(201);
    expect(data<{ order: { status: string } }>(w1verify).order.status).toBe('PARTIALLY_PAID');
    const { rows: txn } = await db.query<{ provider_transaction_id: string }>(
      `SELECT provider_transaction_id FROM payments WHERE id = $1`,
      [w1data.id],
    );
    expect(txn[0]!.provider_transaction_id).toMatch(/^faketxn_/);
    // duplicate verify is idempotent
    const w1again = await boss(`/v1/payments/${w1data.id}/verify`, {}, 'POST');
    expect(w1again.status).toBe(201);
    expect(data<{ replayed?: boolean }>(w1again).replayed).toBe(true);

    // 3) ALIPAY 700 → PENDING → signed webhook completes the order
    const a1 = await boss(
      '/v1/payments',
      { orderId, method: 'ALIPAY', amountCents: 700 },
      'POST',
      'mix-alipay-1',
    );
    expect(a1.status).toBe(201);
    const a1data = data<{ id: string; status: string }>(a1);
    expect(a1data.status).toBe('PENDING');
    const { rows: arow } = await db.query<{ provider_order_id: string }>(
      `SELECT provider_order_id FROM payments WHERE id = $1`,
      [a1data.id],
    );
    expect(arow[0]!.provider_order_id).toMatch(/^fakeord_/);

    const secret = 'test-webhook-secret-test-webhook-123';
    const signed = (parts: {
      providerOrderId: string;
      providerTransactionId: string;
      amountCents: number;
    }) => webhookSignature(secret, parts);

    // forged signature → 403 before anything touches money
    const forged = await call({
      url: '/v1/payments/webhook',
      method: 'POST',
      body: {
        provider: 'fake',
        providerOrderId: arow[0]!.provider_order_id,
        providerTransactionId: 'evil-txn',
        amountCents: 700,
        signature: 'f'.repeat(64),
      },
    });
    expect(forged.status).toBe(403);

    // correctly signed but WRONG amount → server-side amount check (§20 #13)
    const tampered = await call({
      url: '/v1/payments/webhook',
      method: 'POST',
      body: {
        provider: 'fake',
        providerOrderId: arow[0]!.provider_order_id,
        providerTransactionId: 'txn-amt-1',
        amountCents: 1,
        signature: signed({
          providerOrderId: arow[0]!.provider_order_id,
          providerTransactionId: 'txn-amt-1',
          amountCents: 1,
        }),
      },
    });
    expect(tampered.status).toBe(422);
    expect((tampered.body as { error: { code: string } }).error.code).toBe(
      'PROVIDER_VERIFICATION_FAILED',
    );

    // happy path → CAPTURED + PAID + settlement
    const ok = await call({
      url: '/v1/payments/webhook',
      method: 'POST',
      body: {
        provider: 'fake',
        providerOrderId: arow[0]!.provider_order_id,
        providerTransactionId: 'txn-ok-1',
        amountCents: 700,
        signature: signed({
          providerOrderId: arow[0]!.provider_order_id,
          providerTransactionId: 'txn-ok-1',
          amountCents: 700,
        }),
      },
    });
    expect(ok.status).toBe(200);
    expect(data<{ order: { status: string } }>(ok).order.status).toBe('PAID');

    // duplicate callback is idempotent (§13.2)
    const dup = await call({
      url: '/v1/payments/webhook',
      method: 'POST',
      body: {
        provider: 'fake',
        providerOrderId: arow[0]!.provider_order_id,
        providerTransactionId: 'txn-ok-1',
        amountCents: 700,
        signature: signed({
          providerOrderId: arow[0]!.provider_order_id,
          providerTransactionId: 'txn-ok-1',
          amountCents: 700,
        }),
      },
    });
    expect(dup.status).toBe(200);
    expect(data<{ replayed?: boolean }>(dup).replayed).toBe(true);

    // exact invariant: paid = Σ captured = payable (300 + 500 + 700)
    const { rows: ord } = await db.query<{
      paid_cents: string;
      payable_cents: string;
      status: string;
    }>(`SELECT paid_cents, payable_cents, status FROM orders WHERE id = $1`, [orderId]);
    expect(ord[0]!.status).toBe('PAID');
    expect(Number(ord[0]!.paid_cents)).toBe(Number(ord[0]!.payable_cents));
    const { rows: sum } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS total FROM payments
       WHERE order_id = $1 AND status = 'CAPTURED'`,
      [orderId],
    );
    expect(Number(sum[0]!.total)).toBe(Number(ord[0]!.paid_cents));

    // settlement drove the room
    const { rows: room } = await db.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1`,
      [t.roomClean1],
    );
    expect(room[0]!.operational_state).toBe('DIRTY');
  });
});
