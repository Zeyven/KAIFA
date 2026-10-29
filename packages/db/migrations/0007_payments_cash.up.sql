-- 0007_payments_cash — Cash payments + cash session reconciliation
-- (spec §4.7 payments row, §5.4 payment machine, §13.1 cash, §20 invariants
--  #3 provider txn once / #4 idempotency / #7 math reconciliation).
-- up: cash_sessions, payments (+ UNIQUE store/idempotency, partial provider txn)
-- down: full reverse

CREATE TABLE cash_sessions (
  id                   uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id             uuid NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN','CLOSED')),
  opening_float_cents  bigint NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
  -- close snapshots (交班对账): counted vs expected, variance kept for audit
  counted_cash_cents   bigint CHECK (counted_cash_cents IS NULL OR counted_cash_cents >= 0),
  expected_cash_cents  bigint CHECK (expected_cash_cents IS NULL OR expected_cash_cents >= 0),
  variance_cents       bigint,
  business_date        date NOT NULL,
  opened_by            uuid REFERENCES employees (id) ON DELETE SET NULL,
  closed_by            uuid REFERENCES employees (id) ON DELETE SET NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_sessions_close_pair CHECK (
    (status = 'CLOSED' AND closed_at IS NOT NULL
      AND counted_cash_cents IS NOT NULL AND expected_cash_cents IS NOT NULL
      AND variance_cents = counted_cash_cents - expected_cash_cents)
    OR status = 'OPEN'
  )
);
-- exactly one OPEN till per store
CREATE UNIQUE INDEX uq_cash_sessions_open ON cash_sessions (store_id) WHERE status = 'OPEN';
CREATE INDEX idx_cash_sessions_store ON cash_sessions (store_id, status, business_date);

CREATE TABLE payments (
  id                       uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id                 uuid NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  order_id                 uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  cash_session_id          uuid REFERENCES cash_sessions (id) ON DELETE RESTRICT,
  method                   text NOT NULL
                           CHECK (method IN ('CASH','WECHAT','ALIPAY','WALLET','CARD','OTHER')),
  provider                 text NOT NULL DEFAULT 'cash',
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0),
  status                   text NOT NULL DEFAULT 'CREATED'
                           CHECK (status IN ('CREATED','PENDING','CAPTURED','FAILED',
                                             'CANCELLED','PARTIALLY_REFUNDED','REFUNDED')),
  -- provider identifiers (cash uses NULL; uniqueness enforced for real providers)
  provider_transaction_id  text,
  provider_order_id        text,
  -- §7.1 dangerous-write idempotency: one result per key per scope
  idempotency_key          text NOT NULL,
  failure_reason           text,
  captured_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT payments_store_idem_key UNIQUE (store_id, idempotency_key)
);
-- §20 #3: a provider transaction can only ever post once
CREATE UNIQUE INDEX uq_payments_provider_txn ON payments (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX idx_payments_order ON payments (order_id, status);
CREATE INDEX idx_payments_cash_session ON payments (cash_session_id) WHERE cash_session_id IS NOT NULL;
-- captured payments are financial history (append-only, SQLSTATE 23001)
CREATE FUNCTION payments_captured_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'CAPTURED' THEN
      RAISE EXCEPTION 'captured payments are never deleted (refunds append)'
        USING ERRCODE = '23001';
    END IF;
    RETURN OLD;
  END IF;
  -- captured money only ever moves along the refund chain (Phase 16), never back
  IF OLD.status = 'CAPTURED'
     AND NEW.status NOT IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED') THEN
    RAISE EXCEPTION 'captured payments are immutable (refunds append new rows)'
      USING ERRCODE = '23001';
  END IF;
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.order_id <> OLD.order_id THEN
    RAISE EXCEPTION 'payment money/order linkage is immutable'
      USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payments_captured_immutable
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_captured_immutable();
