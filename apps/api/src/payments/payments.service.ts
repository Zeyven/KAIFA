import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  assertOrderTransition,
  assertPaymentTransition,
  isCashMethod,
  MachineError,
  type OrderState,
} from '@lanxu/domain';
import { ApiError } from '@lanxu/contracts';
import { AuditService } from '../audit/audit.service';
import { appendStoreEvent } from '../common/store-events';
import { canTransition as canTransitionRoom } from '@lanxu/domain';
import { PG_POOL, requirePool } from '../db/pg.module';
import { OrdersService, type OrderRow } from '../orders/orders.service';
import { ENV, type AppEnv } from '../env/env.module';
import {
  resolveProvider,
  verifyWebhookSignature,
  webhookSignature,
  type PaymentProvider,
} from './provider';

/**
 * Cash payment + till reconciliation (spec §13.1, §4.7 payments, §20 #3/#4/#7):
 *  - Idempotency-Key is mandatory for POST /payments (dangerous write §7.1)
 *  - capture moves money ONLY in one tx: payment CAPTURED + order paid/status +
 *    payment.updated/order.paid outbox + audit (never two-phase in app code)
 *  - captured rows are immutable (DB trigger) — refunds append (Phase 16)
 *  - a cash capture requires an OPEN till (cash_session_id) for 交班对账
 */

@Injectable()
export class PaymentsService {
  private readonly provider: PaymentProvider | null;
  private readonly webhookSecret: string;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(ENV) env: AppEnv,
  ) {
    this.provider = resolveProvider(env.PAYMENT_PROVIDER);
    this.webhookSecret = env.PAYMENT_WEBHOOK_SECRET;
  }

  private requireProvider(): PaymentProvider {
    if (!this.provider) {
      throw new ApiError(
        'SERVICE_UNAVAILABLE',
        'configured payment provider has no adapter in this environment (real merchant credentials required)',
      );
    }
    return this.provider;
  }

  private db(): Pool {
    return requirePool(this.pool);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db().connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── POST /v1/payments (create, never captures) ───────────────────────

  async create(
    input: { orderId: string; method: string; amountCents: number; cashSessionId?: string },
    idempotencyKey: string,
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ApiError('VALIDATION_FAILED', 'amountCents must be a positive integer');
    }

    return this.tx(async (client) => {
      const orderRes = await client.query<{
        id: string;
        status: string;
        payable_cents: string;
        paid_cents: string;
      }>(
        `SELECT id, status, payable_cents, paid_cents FROM orders
         WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [input.orderId, ctx.storeId],
      );
      const order = orderRes.rows[0];
      if (!order) throw new ApiError('NOT_FOUND', 'order not found');
      const os = order.status as OrderState;
      if (os !== 'PENDING_CHECKOUT' && os !== 'PARTIALLY_PAID') {
        throw new MachineError(
          'INVALID_STATE_TRANSITION',
          `order ${os} is not awaiting payment (checkout first)`,
          422,
        );
      }
      const due = Number(order.payable_cents) - Number(order.paid_cents);
      if (input.amountCents > due) {
        throw new MachineError(
          'PAYMENT_EXCEEDS_DUE',
          `amount ${input.amountCents} exceeds remaining due ${due}`,
          422,
        );
      }

      // attach an OPEN till — CASH only; online money never touches the drawer
      // (split tender, spec §9.4/§13)
      let cashSessionId: string | null = null;
      if (isCashMethod(input.method)) {
        if (input.cashSessionId) {
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM cash_sessions WHERE id = $1 AND store_id = $2 AND status = 'OPEN'`,
            [input.cashSessionId, ctx.storeId],
          );
          if (!rows[0])
            throw new MachineError('CASH_SESSION_REQUIRED', 'cash session not open', 422);
          cashSessionId = rows[0].id;
        } else {
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM cash_sessions WHERE store_id = $1 AND status = 'OPEN'
             ORDER BY opened_at DESC LIMIT 1`,
            [ctx.storeId],
          );
          cashSessionId = rows[0]?.id ?? null;
          if (!cashSessionId) {
            throw new MachineError(
              'CASH_SESSION_REQUIRED',
              'open a cash session before taking money',
              422,
            );
          }
        }
      }

      const inserted = await client.query<{
        id: string;
        status: string;
        amount_cents: string;
        order_id: string;
        method: string;
      }>(
        `INSERT INTO payments
           (store_id, order_id, cash_session_id, method, provider, amount_cents,
            status, idempotency_key, created_by)
         VALUES ($1, $2, $3, 'CASH', 'cash', $4, 'CREATED', $5, $6)
         ON CONFLICT (store_id, idempotency_key) DO NOTHING
         RETURNING id, status, amount_cents, order_id, method`,
        [ctx.storeId, input.orderId, cashSessionId, input.amountCents, idempotencyKey, ctx.actorId],
      );

      if (inserted.rows[0]) {
        const payment = inserted.rows[0];
        let providerPayload: Record<string, unknown> | null = null;
        let status = payment.status;
        if (!isCashMethod(input.method)) {
          // §13.2: provider order created SERVER-SIDE → PENDING; CAPTURED only
          // via server verify / signed webhook (client claims never advance state)
          const provider = this.requireProvider();
          const created = await provider.createOrder({
            paymentId: payment.id,
            orderId: payment.order_id,
            amountCents: input.amountCents,
            method: input.method,
          });
          await client.query(
            `UPDATE payments SET status = 'PENDING', provider = $2, provider_order_id = $3,
                    updated_at = now()
             WHERE id = $1`,
            [payment.id, provider.name, created.providerOrderId],
          );
          status = 'PENDING';
          providerPayload = created.displayPayload;
          await appendStoreEvent(client, {
            storeId: ctx.storeId,
            type: 'payment.updated',
            aggregateType: 'payment',
            aggregateId: payment.id,
            version: 1,
            payload: {
              status: 'PENDING',
              amountCents: input.amountCents,
              orderId: payment.order_id,
            },
          });
        }
        await this.audit.record(client, {
          organizationId: undefined,
          storeId: ctx.storeId,
          actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
          action: 'payment.created',
          resourceType: 'payment',
          resourceId: payment.id,
          after: {
            orderId: payment.order_id,
            method: payment.method,
            amountCents: Number(payment.amount_cents),
            cashSessionId,
            idempotencyKey,
            status,
          },
        });
        return { data: { ...payment, status, replayed: false, providerPayload } };
      }

      // replay: same key — identical request returns the original result (§20 #4)
      const { rows } = await client.query<{
        id: string;
        status: string;
        amount_cents: string;
        order_id: string;
        method: string;
      }>(
        `SELECT id, status, amount_cents, order_id, method FROM payments
         WHERE store_id = $1 AND idempotency_key = $2`,
        [ctx.storeId, idempotencyKey],
      );
      const original = rows[0];
      if (!original) throw new ApiError('INTERNAL_ERROR', 'idempotency conflict unresolved');
      if (
        original.order_id !== input.orderId ||
        Number(original.amount_cents) !== input.amountCents ||
        original.method !== input.method
      ) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different payload',
        );
      }
      return { data: { ...original, replayed: true } };
    });
  }

  // ── POST /v1/payments/:id/capture (cashier confirm → CAPTURED) ───────

  async capture(
    paymentId: string,
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const payRes = await client.query<{
        id: string;
        store_id: string;
        order_id: string;
        cash_session_id: string | null;
        method: string;
        amount_cents: string;
        status: string;
      }>(
        `SELECT id, store_id, order_id, cash_session_id, method, amount_cents, status
         FROM payments WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [paymentId, ctx.storeId],
      );
      const payment = payRes.rows[0];
      if (!payment) throw new ApiError('NOT_FOUND', 'payment not found');
      if (payment.status === 'CAPTURED') return { data: { ...payment, replayed: true } };
      if (payment.status === 'PENDING') {
        throw new MachineError(
          'INVALID_STATE_TRANSITION',
          'online payment must be verified (server query / signed webhook), never cashier-captured',
          422,
        );
      }
      assertPaymentTransition(payment.status as never, 'CAPTURED');

      if (isCashMethod(payment.method)) {
        if (!payment.cash_session_id) {
          throw new MachineError('CASH_SESSION_REQUIRED', 'payment has no cash session', 422);
        }
        const { rows: till } = await client.query<{ status: string }>(
          `SELECT status FROM cash_sessions WHERE id = $1 FOR UPDATE`,
          [payment.cash_session_id],
        );
        if (till[0]?.status !== 'OPEN') {
          throw new MachineError('CASH_SESSION_REQUIRED', 'cash session is closed', 422);
        }
      }

      return this.settleCaptured(client, payment, ctx, 'CASH_CONFIRM');
    });
  }

  /**
   * THE settlement step (shared by cashier confirm, provider verify and the
   * signed webhook): order lock → due re-check → payment CAPTURED + order
   * paid/status + payment.updated/order.paid + visit/room settle + audit —
   * all in the caller's transaction. `ctx.actorId` null ⇒ SYSTEM actor.
   */
  private async settleCaptured(
    client: PoolClient,
    payment: { id: string; order_id: string; amount_cents: string; status: string },
    ctx: { storeId: string; actorId?: string | null; ip: string },
    via: 'CASH_CONFIRM' | 'PROVIDER_VERIFY' | 'WEBHOOK',
  ): Promise<{ data: unknown }> {
    const orderRes = await client.query<{
      id: string;
      status: string;
      payable_cents: string;
      paid_cents: string;
      version: number;
      store_id: string;
    }>(
      `SELECT id, status, payable_cents, paid_cents, version, store_id
       FROM orders WHERE id = $1 FOR UPDATE`,
      [payment.order_id],
    );
    const order = orderRes.rows[0];
    if (!order) throw new ApiError('NOT_FOUND', 'payment order missing');
    const os = order.status as OrderState;
    if (os !== 'PENDING_CHECKOUT' && os !== 'PARTIALLY_PAID') {
      throw new MachineError(
        'INVALID_STATE_TRANSITION',
        `order ${os} is not awaiting payment`,
        422,
      );
    }
    const amount = Number(payment.amount_cents);
    const due = Number(order.payable_cents) - Number(order.paid_cents);
    if (amount > due) {
      throw new MachineError(
        'PAYMENT_EXCEEDS_DUE',
        `payment ${amount} exceeds remaining due ${due}`,
        422,
      );
    }

    const newPaid = Number(order.paid_cents) + amount;
    const newStatus: OrderState =
      newPaid >= Number(order.payable_cents) ? 'PAID' : 'PARTIALLY_PAID';
    if (newStatus !== os) assertOrderTransition(os, newStatus);

    const payUpdated = await client.query<{ id: string; status: string; captured_at: string }>(
      `UPDATE payments SET status = 'CAPTURED', captured_at = now(), updated_at = now()
       WHERE id = $1 RETURNING id, status, captured_at`,
      [payment.id],
    );
    const ordUpdated = await client.query<OrderRow>(
      `UPDATE orders SET paid_cents = $2, status = $3, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [order.id, newPaid, newStatus],
    );
    const bumped = ordUpdated.rows[0]!;

    await this.audit.record(client, {
      storeId: ctx.storeId,
      actor: {
        actorType: ctx.actorId ? 'EMPLOYEE' : 'SYSTEM',
        actorId: ctx.actorId ?? undefined,
        ip: ctx.ip,
      },
      action: 'payment.captured',
      resourceType: 'payment',
      resourceId: payment.id,
      before: { status: payment.status, orderStatus: os },
      after: { status: 'CAPTURED', orderStatus: newStatus, paidCents: newPaid, via },
    });

    await appendStoreEvent(client, {
      storeId: ctx.storeId,
      type: 'payment.updated',
      aggregateType: 'payment',
      aggregateId: payment.id,
      version: 2,
      payload: { status: 'CAPTURED', amountCents: amount, orderId: order.id, via },
    });
    if (newStatus === 'PAID') {
      await appendStoreEvent(client, {
        storeId: ctx.storeId,
        type: 'order.paid',
        aggregateType: 'order',
        aggregateId: order.id,
        version: bumped.version,
        payload: {
          paidCents: newPaid,
          payableCents: Number(bumped.payable_cents),
          storeSeq: null,
        },
      });
      await this.settleVisitAndRoom(client, bumped, ctx);
    } else {
      await this.orders.emitOrderUpdated(client, bumped, 'payment_captured');
    }

    return {
      data: {
        id: payment.id,
        status: payUpdated.rows[0]!.status,
        capturedAt: payUpdated.rows[0]!.captured_at,
        order: bumped,
        replayed: false,
        via,
      },
    };
  }

  // ── POST /v1/payments/:id/verify — server-side provider query (§13.2) ──

  async verify(
    paymentId: string,
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const payRes = await client.query<{
        id: string;
        order_id: string;
        method: string;
        amount_cents: string;
        status: string;
        provider_order_id: string | null;
      }>(
        `SELECT id, order_id, method, amount_cents, status, provider_order_id
         FROM payments WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [paymentId, ctx.storeId],
      );
      const payment = payRes.rows[0];
      if (!payment) throw new ApiError('NOT_FOUND', 'payment not found');
      if (payment.status === 'CAPTURED') return { data: { ...payment, replayed: true } };
      if (payment.status !== 'PENDING' || !payment.provider_order_id) {
        throw new MachineError(
          'INVALID_STATE_TRANSITION',
          `payment ${payment.status} cannot be verified (only PENDING online payments)`,
          422,
        );
      }
      const provider = this.requireProvider();
      const result = await provider.verify({
        providerOrderId: payment.provider_order_id,
        paymentId: payment.id,
        expectedAmountCents: Number(payment.amount_cents),
      });
      // §13.2 server verifies amount — provider echo must match our row
      if (result.verifiedAmountCents !== Number(payment.amount_cents)) {
        await this.audit.security({
          eventType: 'PROVIDER_AMOUNT_MISMATCH',
          storeId: ctx.storeId,
          actorHint: payment.provider_order_id,
          ip: ctx.ip,
        });
        throw new ApiError(
          'PROVIDER_VERIFICATION_FAILED',
          'provider-verified amount does not match the payment',
        );
      }
      await client.query(
        `UPDATE payments SET provider_transaction_id = $2, updated_at = now()
         WHERE id = $1 AND provider_transaction_id IS NULL`,
        [payment.id, result.providerTransactionId],
      );
      return this.settleCaptured(client, { ...payment, status: 'PENDING' }, ctx, 'PROVIDER_VERIFY');
    });
  }

  // ── POST /v1/payments/webhook — signed provider callback (§13.2) ─────

  async webhook(
    input: {
      provider: string;
      providerOrderId: string;
      providerTransactionId: string;
      amountCents: number;
      signature: string;
    },
    ctx: { ip: string },
  ): Promise<{ data: unknown }> {
    const ok = verifyWebhookSignature(this.webhookSecret, {
      providerOrderId: input.providerOrderId,
      providerTransactionId: input.providerTransactionId,
      amountCents: input.amountCents,
      signature: input.signature,
    });
    if (!ok) {
      throw new ApiError('FORBIDDEN', 'webhook signature verification failed');
    }
    return this.tx(async (client) => {
      const payRes = await client.query<{
        id: string;
        store_id: string;
        order_id: string;
        amount_cents: string;
        status: string;
        method: string;
      }>(
        `SELECT id, store_id, order_id, amount_cents, status, method
         FROM payments WHERE provider_order_id = $1`,
        [input.providerOrderId],
      );
      const payment = payRes.rows[0];
      if (!payment) throw new ApiError('NOT_FOUND', 'unknown provider order');
      if (payment.status === 'CAPTURED') {
        return { data: { id: payment.id, status: 'CAPTURED', replayed: true } }; // idempotent callback
      }
      if (payment.status !== 'PENDING') {
        throw new MachineError(
          'INVALID_STATE_TRANSITION',
          `payment ${payment.status} cannot accept a callback`,
          422,
        );
      }
      if (Number(payment.amount_cents) !== input.amountCents) {
        await this.audit.security({
          eventType: 'WEBHOOK_AMOUNT_MISMATCH',
          storeId: payment.store_id,
          actorHint: input.providerTransactionId,
          ip: ctx.ip,
        });
        throw new ApiError(
          'PROVIDER_VERIFICATION_FAILED',
          'callback amount does not match the payment',
        );
      }
      // enforce unique provider txn BEFORE settle (§20 #3 — dedupe at source)
      const { rows: dup } = await client.query<{ id: string }>(
        `SELECT id FROM payments
         WHERE provider = $2 AND provider_transaction_id = $3 AND id <> $1`,
        [payment.id, input.provider, input.providerTransactionId],
      );
      if (dup[0]) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'provider transaction already used');
      }
      await client.query(
        `UPDATE payments SET provider_transaction_id = $2, updated_at = now()
         WHERE id = $1`,
        [payment.id, input.providerTransactionId],
      );
      return this.settleCaptured(
        client,
        { ...payment, status: 'PENDING' },
        { storeId: payment.store_id, actorId: null, ip: ctx.ip },
        'WEBHOOK',
      );
    });
  }

  /** Canonical signature helper (controller exposes the algorithm shape). */
  webhookSignatureFor(parts: {
    providerOrderId: string;
    providerTransactionId: string;
    amountCents: number;
  }): string {
    return webhookSignature(this.webhookSecret, parts);
  }

  // ── GET /v1/payments/:id ─────────────────────────────────────────────

  async get(paymentId: string, storeId: string): Promise<{ data: unknown }> {
    const { rows } = await this.db().query(
      `SELECT id, store_id, order_id, cash_session_id, method, provider, amount_cents,
              status, provider_transaction_id, provider_order_id, captured_at,
              created_at, updated_at
       FROM payments WHERE id = $1 AND store_id = $2`,
      [paymentId, storeId],
    );
    const row = rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'payment not found');
    return { data: row };
  }

  /**
   * Golden path on PAID: close the ACTIVE visit + apply room ORDER_PAID
   * (→ DIRTY, then manual cleaning → VACANT_CLEAN). Soft-skips when the room
   * already moved (never fails a capture on bookkeeping) — money first.
   */
  private async settleVisitAndRoom(
    client: PoolClient,
    order: OrderRow,
    ctx: { storeId: string; actorId?: string | null; ip: string },
  ): Promise<void> {
    const visitRes = await client.query<{ id: string; room_id: string }>(
      `UPDATE visits SET status = 'CLOSED', closed_at = now()
       WHERE id = (SELECT visit_id FROM orders WHERE id = $1) AND status = 'ACTIVE'
         AND store_id = $2
       RETURNING id, room_id`,
      [order.id, ctx.storeId],
    );
    const visit = visitRes.rows[0];
    if (!visit) return; // goods-only invoice without a live visit (reopened edge)

    await appendStoreEvent(client, {
      storeId: ctx.storeId,
      type: 'visit.closed',
      aggregateType: 'visit',
      aggregateId: visit.id,
      payload: { roomId: visit.room_id, via: 'ORDER_PAID', orderId: order.id },
    });
    await this.audit.record(client, {
      storeId: ctx.storeId,
      actor: {
        actorType: ctx.actorId ? 'EMPLOYEE' : 'SYSTEM',
        actorId: ctx.actorId ?? undefined,
        ip: ctx.ip,
      },
      action: 'visit.closed',
      resourceType: 'visit',
      resourceId: visit.id,
      before: { status: 'ACTIVE' },
      after: { status: 'CLOSED', via: 'ORDER_PAID', orderId: order.id },
    });

    const roomRes = await client.query<{ operational_state: string }>(
      `SELECT operational_state FROM rooms WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [visit.room_id, ctx.storeId],
    );
    const room = roomRes.rows[0];
    if (!room) return;
    const applied = canTransitionRoom(
      room.operational_state as Parameters<typeof canTransitionRoom>[0],
      'ORDER_PAID',
      { balanceSettled: true, hasActiveVisit: false },
    );
    if (!applied.ok) return; // already vacated/cleaned by another path
    await client.query(
      `UPDATE rooms SET operational_state = $2, current_visit_id = NULL,
              version = version + 1, updated_at = now()
       WHERE id = $1`,
      [visit.room_id, applied.next],
    );
    await appendStoreEvent(client, {
      storeId: ctx.storeId,
      type: 'room.updated',
      aggregateType: 'room',
      aggregateId: visit.room_id,
      payload: { roomId: visit.room_id, operationalState: applied.next, via: 'ORDER_PAID' },
    });
  }

  // ── cash sessions (till + 交班对账) ──────────────────────────────────

  async openCashSession(
    input: { openingFloatCents?: number },
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown; created: boolean }> {
    const float = input.openingFloatCents ?? 0;
    if (!Number.isSafeInteger(float) || float < 0) {
      throw new ApiError('VALIDATION_FAILED', 'openingFloatCents must be a non-negative integer');
    }
    return this.tx(async (client) => {
      const existing = await client.query(
        `SELECT id, store_id, status, opening_float_cents, business_date, opened_at
         FROM cash_sessions WHERE store_id = $1 AND status = 'OPEN' FOR UPDATE`,
        [ctx.storeId],
      );
      if (existing.rows[0]) return { data: existing.rows[0], created: false };
      const { rows } = await client.query(
        `INSERT INTO cash_sessions (store_id, opening_float_cents, business_date, opened_by)
         SELECT $1, $2, ((now() AT TIME ZONE s.timezone)::date
                  - CASE WHEN (now() AT TIME ZONE s.timezone)::time < s.business_date_cutoff_time
                         THEN 1 ELSE 0 END), $3
         FROM stores s WHERE s.id = $1
         RETURNING id, store_id, status, opening_float_cents, business_date, opened_at`,
        [ctx.storeId, float, ctx.actorId],
      );
      const created = rows[0];
      if (!created) throw new ApiError('NOT_FOUND', 'store not found');
      await this.audit.record(client, {
        storeId: ctx.storeId,
        actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
        action: 'cash_session.opened',
        resourceType: 'cash_session',
        resourceId: created.id as string,
        after: { openingFloatCents: float },
      });
      return { data: created, created: true };
    });
  }

  async closeCashSession(
    cashSessionId: string,
    input: { countedCashCents: number },
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    if (!Number.isSafeInteger(input.countedCashCents) || input.countedCashCents < 0) {
      throw new ApiError('VALIDATION_FAILED', 'countedCashCents must be a non-negative integer');
    }
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        opening_float_cents: string;
      }>(
        `SELECT id, status, opening_float_cents FROM cash_sessions
         WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [cashSessionId, ctx.storeId],
      );
      const till = rows[0];
      if (!till) throw new ApiError('NOT_FOUND', 'cash session not found');
      if (till.status === 'CLOSED') {
        throw new MachineError('INVALID_STATE_TRANSITION', 'cash session already closed', 422);
      }
      const sums = await client.query<{ captured: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS captured FROM payments
         WHERE cash_session_id = $1 AND status = 'CAPTURED' AND method = 'CASH'`,
        [cashSessionId],
      );
      const expected = Number(till.opening_float_cents) + Number(sums.rows[0]!.captured);
      const variance = input.countedCashCents - expected;
      const closed = await client.query(
        `UPDATE cash_sessions SET status = 'CLOSED', counted_cash_cents = $2,
                expected_cash_cents = $3, variance_cents = $4, closed_by = $5, closed_at = now(),
                updated_at = now()
         WHERE id = $1
         RETURNING id, store_id, status, opening_float_cents, counted_cash_cents,
                   expected_cash_cents, variance_cents, opened_at, closed_at`,
        [cashSessionId, input.countedCashCents, expected, variance, ctx.actorId],
      );
      await this.audit.record(client, {
        storeId: ctx.storeId,
        actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
        action: 'cash_session.closed',
        resourceType: 'cash_session',
        resourceId: cashSessionId,
        before: { status: 'OPEN' },
        after: {
          status: 'CLOSED',
          expectedCashCents: expected,
          countedCashCents: input.countedCashCents,
          varianceCents: variance,
        },
      });
      return { data: closed.rows[0] };
    });
  }

  async listCashSessions(storeId: string, limit = 50): Promise<{ data: unknown }> {
    const { rows } = await this.db().query(
      `SELECT id, store_id, status, opening_float_cents, counted_cash_cents,
              expected_cash_cents, variance_cents, business_date, opened_at, closed_at
       FROM cash_sessions WHERE store_id = $1
       ORDER BY opened_at DESC LIMIT $2`,
      [storeId, Math.min(Math.max(limit, 1), 200)],
    );
    return { data: { items: rows, nextCursor: null } };
  }
}
