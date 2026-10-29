import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  assertOrderTransition,
  canCheckout,
  isLiveOrderState,
  MachineError,
  type OrderState,
} from '@lanxu/domain';
import { ApiError } from '@lanxu/contracts';
import { AuditService } from '../audit/audit.service';
import { appendStoreEvent } from '../common/store-events';
import { PG_POOL, requirePool } from '../db/pg.module';

/**
 * Order Engine (spec §4.7 tables, §5.4 machine, §9.4 cashier math, invariant
 * #11 成交快照 / #7 数学对账):
 *  - prices are server-authoritative (products.list_price_cents / session price_cents)
 *  - items snapshot name+price at insertion (catalog drift never rewrites history)
 *  - one live order per visit (partial unique) + one ACTIVE bill per session
 *  - every mutation recomputes totals under lock and emits order.updated in the
 *    SAME transaction (outbox invariant)
 */

const ACTIVE_SESSION_STATES = `('DRAFT','ASSIGNED','ACKNOWLEDGED','ARRIVED','STARTED','ENDING_SOON')`;

export interface OrderRow {
  id: string;
  store_id: string;
  visit_id: string;
  status: string;
  subtotal_cents: string;
  discount_cents: string;
  payable_cents: string;
  paid_cents: string;
  refunded_cents: string;
  business_date: string;
  version: number;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private db(): Pool {
    return requirePool(this.pool);
  }

  // ── shared tx helpers (used by SessionsService hooks too) ─────────────

  /** Find-or-create the live order for a visit, under row lock. */
  async ensureOrderForVisit(
    client: PoolClient,
    input: { storeId: string; visitId: string; openedBy?: string | null },
  ): Promise<OrderRow> {
    const existing = await client.query<OrderRow>(
      `SELECT * FROM orders
       WHERE visit_id = $1 AND status IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT','PARTIALLY_PAID')
       FOR UPDATE`,
      [input.visitId],
    );
    if (existing.rows[0]) return existing.rows[0];

    try {
      const inserted = await client.query<OrderRow>(
        `INSERT INTO orders (store_id, visit_id, business_date, opened_by)
         SELECT $1, id, business_date, $3 FROM visits WHERE id = $2 AND store_id = $1
         RETURNING *`,
        [input.storeId, input.visitId, input.openedBy ?? null],
      );
      const row = inserted.rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'visit not found');
      return row;
    } catch (err) {
      // concurrent open → partial unique uq_orders_live_visit wins; re-read it
      if ((err as { code?: string }).code === '23505') {
        const again = await client.query<OrderRow>(
          `SELECT * FROM orders
           WHERE visit_id = $1 AND status IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT','PARTIALLY_PAID')
           FOR UPDATE`,
          [input.visitId],
        );
        if (again.rows[0]) return again.rows[0];
      }
      throw err;
    }
  }

  /** Recompute totals from immutable components (§7 math must reconcile). */
  async recomputeTotals(client: PoolClient, orderId: string): Promise<OrderRow> {
    const { rows } = await client.query<OrderRow>(
      `WITH sums AS (
         SELECT COALESCE(SUM(gross_cents), 0) AS sub,
                COALESCE(SUM(discount_cents), 0) AS item_disc
         FROM order_items WHERE order_id = $1 AND status = 'ACTIVE'
       ), adj AS (
         SELECT COALESCE(SUM(amount_cents), 0) AS adj_disc
         FROM order_adjustments WHERE order_id = $1
       )
       UPDATE orders o SET
         subtotal_cents = sums.sub,
         discount_cents = LEAST(sums.item_disc + adj.adj_disc, sums.sub),
         payable_cents = GREATEST(0, sums.sub - LEAST(sums.item_disc + adj.adj_disc, sums.sub)),
         updated_at = now()
       FROM sums, adj
       WHERE o.id = $1
       RETURNING o.*`,
      [orderId],
    );
    const row = rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'order not found');
    return row;
  }

  async emitOrderUpdated(client: PoolClient, order: OrderRow, reason: string): Promise<void> {
    await appendStoreEvent(client, {
      storeId: order.store_id,
      type: 'order.updated',
      aggregateType: 'order',
      aggregateId: order.id,
      version: order.version,
      payload: {
        reason,
        status: order.status,
        subtotalCents: Number(order.subtotal_cents),
        discountCents: Number(order.discount_cents),
        payableCents: Number(order.payable_cents),
        paidCents: Number(order.paid_cents),
      },
    });
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

  private async loadScoped(
    client: Pool | PoolClient,
    orderId: string,
    storeId: string,
  ): Promise<OrderRow> {
    const { rows } = await client.query<OrderRow>(
      `SELECT * FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [orderId, storeId],
    );
    const row = rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'order not found');
    return row;
  }

  private assertLive(order: OrderRow, forItems: boolean): void {
    const s = order.status as OrderState;
    if (forItems) {
      if (s !== 'OPEN' && s !== 'IN_SERVICE') {
        throw new MachineError(
          'INVALID_STATE_TRANSITION',
          `order ${s} is frozen for new items (checkout in progress)`,
          422,
        );
      }
      return;
    }
    if (!isLiveOrderState(s) && s !== 'PENDING_CHECKOUT') {
      throw new MachineError('INVALID_STATE_TRANSITION', `order ${s} cannot be modified`, 422);
    }
  }

  // ── commands ─────────────────────────────────────────────────────────

  /**
   * POST /v1/orders/open — idempotent find-or-create for a visit (the front
   * desk's "拿单" command; concurrent calls converge on the partial unique).
   */
  async open(
    input: { visitId: string },
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown; created: boolean }> {
    return this.tx(async (client) => {
      const visit = await client.query<{ id: string }>(
        `SELECT id FROM visits WHERE id = $1 AND store_id = $2`,
        [input.visitId, ctx.storeId],
      );
      if (!visit.rows[0]) throw new ApiError('NOT_FOUND', 'visit not found');
      const before = await client.query<{ id: string }>(
        `SELECT id FROM orders WHERE visit_id = $1 AND status IN
           ('OPEN','IN_SERVICE','PENDING_CHECKOUT','PARTIALLY_PAID')`,
        [input.visitId],
      );
      const order = await this.ensureOrderForVisit(client, {
        storeId: ctx.storeId,
        visitId: input.visitId,
        openedBy: ctx.actorId,
      });
      const created = before.rows.length === 0;
      if (created) {
        await this.audit.record(client, {
          organizationId: undefined,
          actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
          action: 'order.opened',
          resourceType: 'order',
          resourceId: order.id,
          after: { visitId: input.visitId, status: order.status },
        });
        await this.emitOrderUpdated(client, order, 'opened');
      }
      return { data: order, created };
    });
  }

  /** GET /v1/orders/{id} — items + adjustments snapshot. */
  async get(orderId: string, storeId: string): Promise<{ data: unknown }> {
    const client = await this.db().connect();
    try {
      const order = await this.loadScoped(client, orderId, storeId);
      const [items, adjustments, activeSessions] = await Promise.all([
        client.query(
          `SELECT id, item_type, service_session_id, service_variant_id, product_id,
                  name_snapshot, quantity, unit_price_cents, gross_cents,
                  discount_cents, net_cents, status, created_at
           FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
          [orderId],
        ),
        client.query(
          `SELECT id, order_item_id, type, amount_cents, reason_code, actor_id, created_at
           FROM order_adjustments WHERE order_id = $1 ORDER BY created_at, id`,
          [orderId],
        ),
        client.query<{ id: string }>(
          `SELECT id FROM service_sessions WHERE visit_id = $1 AND status IN ${ACTIVE_SESSION_STATES}`,
          [order.visit_id],
        ),
      ]);
      return {
        data: {
          ...order,
          items: items.rows,
          adjustments: adjustments.rows,
          activeSessionCount: activeSessions.rows.length,
        },
      };
    } finally {
      client.release();
    }
  }

  /** GET /v1/orders — store list (status/visitId/today filters). */
  async list(
    storeId: string,
    q: { status?: string; visitId?: string; today?: boolean; limit?: number },
  ): Promise<{ data: unknown }> {
    const conds: string[] = ['o.store_id = $1'];
    const params: unknown[] = [storeId];
    let i = 2;
    if (q.status) {
      conds.push(`o.status = $${i}`);
      params.push(q.status);
      i += 1;
    }
    if (q.visitId) {
      conds.push(`o.visit_id = $${i}`);
      params.push(q.visitId);
      i += 1;
    }
    if (q.today) {
      conds.push(
        `o.business_date = ((now() AT TIME ZONE st.timezone)::date
           - CASE WHEN (now() AT TIME ZONE st.timezone)::time < st.business_date_cutoff_time
                  THEN 1 ELSE 0 END)`,
      );
    }
    params.push(Math.min(Math.max(q.limit ?? 100, 1), 500));
    const { rows } = await this.db().query(
      `SELECT o.id, o.visit_id, o.customer_id, o.status, o.subtotal_cents, o.discount_cents,
              o.payable_cents, o.paid_cents, o.refunded_cents, o.business_date, o.version,
              o.created_at, o.updated_at
       FROM orders o
       JOIN stores st ON st.id = o.store_id
       WHERE ${conds.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${i}`,
      params,
    );
    return { data: { items: rows, nextCursor: null } };
  }

  /**
   * POST /v1/orders/{id}/items — ring a line item. Prices come from the
   * server catalog (products.list_price_cents / variant price), never the
   * client (§20 financial integrity).
   */
  async addItem(
    orderId: string,
    input: { productId?: string; serviceVariantId?: string; quantity?: number },
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    const quantity = Math.max(1, input.quantity ?? 1);
    if (
      (!input.productId && !input.serviceVariantId) ||
      (input.productId && input.serviceVariantId)
    ) {
      throw new ApiError('VALIDATION_FAILED', 'exactly one of productId/serviceVariantId required');
    }
    return this.tx(async (client) => {
      const order = await this.loadScoped(client, orderId, ctx.storeId);
      this.assertLive(order, true);

      let item: { name: string; unit: string; typeId: string };
      if (input.productId) {
        const { rows } = await client.query<{
          name: string;
          list_price_cents: string;
          org: string;
        }>(
          `SELECT p.name, p.list_price_cents, s.organization_id AS org
           FROM products p JOIN stores s ON s.id = $2
           WHERE p.id = $1 AND p.organization_id = s.organization_id AND p.status = 'ACTIVE'`,
          [input.productId, ctx.storeId],
        );
        const p = rows[0];
        if (!p) throw new ApiError('NOT_FOUND', 'product not found');
        item = { name: p.name, unit: p.list_price_cents, typeId: input.productId };
        await this.insertItem(client, {
          orderId: order.id,
          itemType: 'PRODUCT',
          productId: input.productId,
          nameSnapshot: p.name,
          quantity,
          unitPrice: Number(p.list_price_cents),
        });
      } else {
        const variantId = input.serviceVariantId;
        if (!variantId) throw new ApiError('VALIDATION_FAILED', 'serviceVariantId required');
        const { rows } = await client.query<{ name: string; price: string }>(
          `SELECT CONCAT(s.name, ' · ', v.name) AS name, v.base_price_cents AS price
           FROM service_variants v
           JOIN services s ON s.id = v.service_id
           JOIN stores st ON st.id = $2
           WHERE v.id = $1 AND s.organization_id = st.organization_id AND v.status = 'ACTIVE'`,
          [variantId, ctx.storeId],
        );
        const v = rows[0];
        if (!v) throw new ApiError('NOT_FOUND', 'service variant not found');
        item = { name: v.name, unit: v.price, typeId: variantId };
        await this.insertItem(client, {
          orderId: order.id,
          itemType: 'SERVICE',
          serviceVariantId: variantId,
          nameSnapshot: v.name,
          quantity,
          unitPrice: Number(v.price),
        });
      }
      void item;

      const updated = await this.recomputeTotals(client, order.id);
      const bumped = await this.bumpVersion(client, updated);
      await this.audit.record(client, {
        actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
        action: 'order.item_added',
        resourceType: 'order',
        resourceId: order.id,
        after: {
          quantity,
          productId: input.productId ?? null,
          serviceVariantId: input.serviceVariantId ?? null,
        },
      });
      await this.emitOrderUpdated(client, bumped, 'item_added');
      return { data: bumped };
    });
  }

  private async insertItem(
    client: PoolClient,
    input: {
      orderId: string;
      itemType: 'PRODUCT' | 'SERVICE';
      productId?: string;
      serviceVariantId?: string;
      serviceSessionId?: string;
      nameSnapshot: string;
      quantity: number;
      unitPrice: number;
    },
  ): Promise<void> {
    const gross = input.unitPrice * input.quantity;
    await client.query(
      `INSERT INTO order_items
         (order_id, item_type, service_session_id, service_variant_id, product_id,
          name_snapshot, quantity, unit_price_cents, gross_cents, net_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $9::bigint)`,
      [
        input.orderId,
        input.itemType,
        input.serviceSessionId ?? null,
        input.serviceVariantId ?? null,
        input.productId ?? null,
        input.nameSnapshot,
        input.quantity,
        input.unitPrice,
        gross,
      ],
    );
  }

  /**
   * POST /v1/orders/{id}/discounts — order-level (or line) discount recorded
   * as an append-only adjustment. Cumulative over threshold ⇒ APPROVAL_REQUIRED
   * (approval wiring lands Phase 23 — until then the command fails closed).
   */
  async applyDiscount(
    orderId: string,
    input: { amountCents: number; reasonCode?: string; orderItemId?: string },
    ctx: { storeId: string; actorId: string; ip: string; thresholdCents: number },
  ): Promise<{ data: unknown }> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ApiError('VALIDATION_FAILED', 'amountCents must be a positive integer (cents)');
    }
    return this.tx(async (client) => {
      const order = await this.loadScoped(client, orderId, ctx.storeId);
      const s = order.status as OrderState;
      if (s !== 'OPEN' && s !== 'IN_SERVICE' && s !== 'PENDING_CHECKOUT') {
        throw new MachineError('INVALID_STATE_TRANSITION', `order ${s} cannot be discounted`, 422);
      }
      if (input.orderItemId) {
        const { rows } = await client.query(
          `SELECT 1 FROM order_items WHERE id = $1 AND order_id = $2`,
          [input.orderItemId, orderId],
        );
        if (!rows[0]) throw new ApiError('NOT_FOUND', 'order item not found');
      }
      const { rows: sumRows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM order_adjustments WHERE order_id = $1`,
        [orderId],
      );
      const cumulative = Number(sumRows[0]!.total) + input.amountCents;
      if (cumulative > ctx.thresholdCents) {
        throw new MachineError(
          'APPROVAL_REQUIRED',
          `cumulative discount ${cumulative} cents exceeds threshold ${ctx.thresholdCents} (BUSINESS POLICY — REQUIRES PILOT VALIDATION)`,
          422,
        );
      }
      await client.query(
        `INSERT INTO order_adjustments (order_id, order_item_id, type, amount_cents, reason_code, actor_id)
         VALUES ($1, $2, 'DISCOUNT', $3, $4, $5)`,
        [
          orderId,
          input.orderItemId ?? null,
          input.amountCents,
          input.reasonCode ?? null,
          ctx.actorId,
        ],
      );
      const recomputed = await this.recomputeTotals(client, orderId);
      const bumped = await this.bumpVersion(client, recomputed);
      await this.audit.record(client, {
        actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
        action: 'order.discount_applied',
        resourceType: 'order',
        resourceId: orderId,
        after: { amountCents: input.amountCents, reasonCode: input.reasonCode ?? null, cumulative },
      });
      await this.emitOrderUpdated(client, bumped, 'discount_applied');
      return { data: bumped };
    });
  }

  private async bumpVersion(client: PoolClient, order: OrderRow): Promise<OrderRow> {
    const { rows } = await client.query<OrderRow>(
      `UPDATE orders SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [order.id],
    );
    return rows[0]!;
  }

  /**
   * POST /v1/orders/{id}/checkout — freeze the bill at PENDING_CHECKOUT.
   * Refuses while any session on the visit is still running (golden path
   * 下钟→结账); re-freezing an already-frozen order is idempotent.
   */
  async checkout(
    orderId: string,
    input: { expectedVersion?: number },
    ctx: { storeId: string; actorId: string; ip: string },
  ): Promise<{ data: unknown }> {
    return this.tx(async (client) => {
      const order = await this.loadScoped(client, orderId, ctx.storeId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== order.version) {
        throw new ApiError('VERSION_CONFLICT', 'order changed since read');
      }
      if (order.status === 'PENDING_CHECKOUT') return { data: order }; // idempotent

      const s = order.status as OrderState;
      if (!canCheckout(s)) {
        throw new MachineError('INVALID_STATE_TRANSITION', `order ${s} cannot checkout`, 422);
      }
      const { rows: active } = await client.query<{ id: string }>(
        `SELECT id FROM service_sessions WHERE visit_id = $1 AND status IN ${ACTIVE_SESSION_STATES}`,
        [order.visit_id],
      );
      if (active.length > 0) {
        throw new ApiError(
          'ORDER_HAS_ACTIVE_SERVICE',
          `visit still has ${active.length} active service session(s)`,
        );
      }
      const recomputed = await this.recomputeTotals(client, orderId);
      assertOrderTransition(recomputed.status as OrderState, 'PENDING_CHECKOUT');
      const { rows: updated } = await client.query<OrderRow>(
        `UPDATE orders SET status = 'PENDING_CHECKOUT', version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [orderId],
      );
      const bumped = updated[0]!;
      await this.audit.record(client, {
        actor: { actorType: 'EMPLOYEE', actorId: ctx.actorId, ip: ctx.ip },
        action: 'order.checkout_started',
        resourceType: 'order',
        resourceId: orderId,
        before: { status: recomputed.status, payableCents: Number(recomputed.payable_cents) },
        after: { status: bumped.status, payableCents: Number(bumped.payable_cents) },
      });
      await this.emitOrderUpdated(client, bumped, 'checkout_started');
      return { data: bumped };
    });
  }

  // ── hooks invoked by SessionsService inside its own transaction ──────

  /** Session CREATE → ensure the visit has a live order (never lose a bill). */
  async hookEnsureOrderOnSessionCreate(
    client: PoolClient,
    input: { storeId: string; visitId: string },
  ): Promise<OrderRow> {
    return this.ensureOrderForVisit(client, input);
  }

  /** Session START → OPEN→IN_SERVICE (no-op otherwise). */
  async hookMarkInService(client: PoolClient, storeId: string, visitId: string): Promise<void> {
    const { rows } = await client.query<OrderRow>(
      `UPDATE orders SET status = 'IN_SERVICE', version = version + 1, updated_at = now()
       WHERE visit_id = $1 AND store_id = $2 AND status = 'OPEN'
       RETURNING *`,
      [visitId, storeId],
    );
    const order = rows[0];
    if (order) await this.emitOrderUpdated(client, order, 'service_started');
  }

  /**
   * Session COMPLETE → attach the billable SERVICE line with a price snapshot
   * (§4.7 name_snapshot; unique index makes double-billing impossible).
   * Returns true when a line was actually inserted.
   */
  async hookAttachServiceItem(
    client: PoolClient,
    input: {
      storeId: string;
      visitId: string;
      sessionId: string;
      session: { price_cents: number | string; service_variant_id: string };
    },
  ): Promise<boolean> {
    const order = await this.ensureOrderForVisit(client, {
      storeId: input.storeId,
      visitId: input.visitId,
    });
    const { rows: nameRows } = await client.query<{ name: string }>(
      `SELECT CONCAT(s.name, ' · ', v.name) AS name
       FROM service_variants v JOIN services s ON s.id = v.service_id
       WHERE v.id = $1`,
      [input.session.service_variant_id],
    );
    const snapshot = nameRows[0]?.name ?? '服务';
    const unit = Number(input.session.price_cents);
    const inserted = await client.query(
      `INSERT INTO order_items
         (order_id, item_type, service_session_id, service_variant_id,
          name_snapshot, quantity, unit_price_cents, gross_cents, net_cents)
       VALUES ($1, 'SERVICE', $2, $3, $4, 1, $5, $5, $5)
       ON CONFLICT (service_session_id) WHERE service_session_id IS NOT NULL AND status = 'ACTIVE'
       DO NOTHING`,
      [order.id, input.sessionId, input.session.service_variant_id, snapshot, unit],
    );
    if (inserted.rowCount === 0) return false;
    await client.query(`UPDATE service_sessions SET order_id = $1 WHERE id = $2`, [
      order.id,
      input.sessionId,
    ]);
    const recomputed = await this.recomputeTotals(client, order.id);
    const bumped = await this.bumpVersion(client, recomputed);
    await this.emitOrderUpdated(client, bumped, 'service_item_attached');
    return true;
  }
}
