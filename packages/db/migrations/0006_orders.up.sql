-- 0006_orders — Order engine (spec §4.7 Orders/Payment core, §5.4 order machine,
-- invariant #11 成交快照, #7 数学对账).
-- up: products (price needed to ring goods — spec §4.x product row lacks one),
--     orders / order_items / order_adjustments + RBAC
-- down: full reverse

CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  sku              text NOT NULL,
  name             text NOT NULL,
  category         text,
  unit             text,
  -- authoritative sell price (clients never supply prices, §7.1/§20)
  list_price_cents bigint NOT NULL DEFAULT 0 CHECK (list_price_cents >= 0),
  status           text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'INACTIVE', 'DISCONTINUED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_org_sku_key UNIQUE (organization_id, sku)
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id        uuid NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  visit_id        uuid NOT NULL REFERENCES visits (id) ON DELETE RESTRICT,
  customer_id     uuid,  -- FK to customers lands with migration 0007 (member phase)
  status          text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT','PARTIALLY_PAID',
                                    'PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),
  subtotal_cents  bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents  bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  payable_cents   bigint NOT NULL DEFAULT 0 CHECK (payable_cents >= 0),
  paid_cents      bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  refunded_cents  bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  business_date   date NOT NULL,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  opened_by       uuid REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT orders_amounts_consistent CHECK (
    payable_cents = GREATEST(0, subtotal_cents - discount_cents)
    AND discount_cents <= subtotal_cents
    AND refunded_cents <= paid_cents
  ),
  CONSTRAINT orders_paid_matches_status CHECK (
    (status IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT') AND paid_cents = 0 AND refunded_cents = 0)
    OR status NOT IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT')
  )
);
-- one live order per visit (concurrent open cannot fork the bill)
CREATE UNIQUE INDEX uq_orders_live_visit ON orders (visit_id)
  WHERE status IN ('OPEN','IN_SERVICE','PENDING_CHECKOUT','PARTIALLY_PAID');
CREATE INDEX idx_orders_store_status ON orders (store_id, status, business_date);

ALTER TABLE service_sessions
  ADD CONSTRAINT fk_service_sessions_order FOREIGN KEY (order_id)
  REFERENCES orders (id) ON DELETE SET NULL;

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  order_id           uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  item_type          text NOT NULL CHECK (item_type IN ('SERVICE','PRODUCT')),
  service_session_id uuid REFERENCES service_sessions (id) ON DELETE RESTRICT,
  service_variant_id uuid REFERENCES service_variants (id) ON DELETE RESTRICT,
  product_id         uuid REFERENCES products (id) ON DELETE RESTRICT,
  name_snapshot      text NOT NULL,           -- 成交快照 — never drifts with catalog
  quantity           integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents   bigint NOT NULL CHECK (unit_price_cents >= 0),
  gross_cents        bigint NOT NULL CHECK (gross_cents >= 0),
  discount_cents     bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  net_cents          bigint NOT NULL CHECK (net_cents >= 0),
  status             text NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','VOID')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_math CHECK (
    gross_cents = unit_price_cents * quantity
    AND net_cents = gross_cents - discount_cents
    AND discount_cents <= gross_cents
  ),
  CONSTRAINT order_items_refs CHECK (
    (item_type = 'SERVICE' AND service_variant_id IS NOT NULL AND product_id IS NULL)
    OR (item_type = 'PRODUCT' AND product_id IS NOT NULL
        AND service_session_id IS NULL AND service_variant_id IS NULL)
  )
);
-- a completed session can be billed EXACTLY ONCE (double-billing blocker, §22.1)
CREATE UNIQUE INDEX uq_order_items_session ON order_items (service_session_id)
  WHERE service_session_id IS NOT NULL AND status = 'ACTIVE';
CREATE INDEX idx_order_items_order ON order_items (order_id, status);

CREATE TABLE order_adjustments (
  id            uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  order_id      uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  order_item_id uuid REFERENCES order_items (id) ON DELETE RESTRICT,
  type          text NOT NULL CHECK (type IN ('DISCOUNT','PRICE_OVERRIDE','COMP')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  reason_code   text,
  actor_id      uuid REFERENCES employees (id) ON DELETE SET NULL,
  approval_id   uuid,   -- approval_requests joins with migration 0023
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- financial history is append-only (SQLSTATE 23001, same pattern as payments)
CREATE FUNCTION order_adjustments_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_adjustments are append-only'
    USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_adjustments_immutable
  BEFORE UPDATE OR DELETE ON order_adjustments
  FOR EACH ROW EXECUTE FUNCTION order_adjustments_immutable();

-- RBAC: order.read for every real system role (0001 role set); corrective
-- grants: clockroom/finance were missed by 0004/0005 read lists (roles that
-- do not exist — role.employee/role.cleaner — silently matched nothing there).
INSERT INTO permissions (code, description) VALUES
  ('order.read', 'View orders, items and totals')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'order.read'
WHERE r.code IN ('role.frontdesk','role.cashier','role.clockroom','role.technician',
                 'role.supervisor','role.manager','role.finance','role.boss')
ON CONFLICT DO NOTHING;

-- corrective backfill (additive, idempotent): read coverage for finance/clockroom
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('service.read','device.read')
WHERE r.code IN ('role.clockroom','role.finance')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
