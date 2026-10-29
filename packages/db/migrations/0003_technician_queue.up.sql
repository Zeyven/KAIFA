-- 0003_technician_queue.up.sql
-- Technician domain + scheduling queue (spec §4.4 catalog subset, §4.5 Technician/Queue,
-- §5.2 states, §6 scheduling). Same conventions as 0001/0002: lanxu_uuidv7 PKs,
-- timestamptz, bigint-cents, explicit CHECKs, append-only history tables.
--
-- Lock risk: LOW (new tables only; single small permission INSERTs; CREATE INDEX on
-- empty tables).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Catalog subset required by technician skills (spec §4.4).
-- Full catalog/price-book management arrives with Order/Pricing phases;
-- products/price_books intentionally deferred.
-- ---------------------------------------------------------------------
CREATE TABLE service_categories (
  id          uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id    uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_categories_store ON service_categories (store_id, sort_order);

CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  code             text NOT NULL,
  name             text NOT NULL,
  category_id      uuid REFERENCES service_categories (id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'DISCONTINUED', 'INACTIVE')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_org_code_key UNIQUE (organization_id, code)
);

CREATE TABLE service_variants (
  id                  uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  service_id          uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  code                text NOT NULL,
  name                text NOT NULL,
  duration_minutes    integer NOT NULL CHECK (duration_minutes > 0),
  base_price_cents    bigint NOT NULL CHECK (base_price_cents >= 0),
  -- BUSINESS POLICY — REQUIRES PILOT VALIDATION: commission category vocabulary
  commission_category text NOT NULL DEFAULT 'STANDARD'
                        CHECK (commission_category IN ('STANDARD', 'PREMIUM', 'PROMO')),
  status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_variants_service_code_key UNIQUE (service_id, code)
);

-- ---------------------------------------------------------------------
-- technicians (spec §4.5)
-- status vocabulary = §5.2 machine states; transitions go through domain
-- commands only (never arbitrary client PATCH).
-- ---------------------------------------------------------------------
CREATE TABLE technicians (
  id             uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  employee_id    uuid NOT NULL UNIQUE REFERENCES employees (id) ON DELETE RESTRICT,
  store_id       uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  technician_no  text NOT NULL,
  -- BUSINESS POLICY — REQUIRES PILOT VALIDATION: level/gender vocabularies are
  -- unconstrained text until store config lands; scheduling consumes them as-is.
  level          text NOT NULL DEFAULT 'L1',
  gender_code    text NOT NULL DEFAULT 'UNSPECIFIED',
  queue_enabled  boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'OFF_DUTY'
                   CHECK (status IN ('OFF_DUTY', 'AVAILABLE', 'ASSIGNED',
                                     'GOING_TO_ROOM', 'WAITING_START', 'SERVING',
                                     'BREAK', 'LOCKED')),
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technicians_store_no_key UNIQUE (store_id, technician_no)
);

CREATE TABLE technician_skills (
  technician_id      uuid NOT NULL REFERENCES technicians (id) ON DELETE CASCADE,
  service_variant_id uuid NOT NULL REFERENCES service_variants (id) ON DELETE CASCADE,
  skill_level        integer NOT NULL DEFAULT 1 CHECK (skill_level >= 1),
  enabled            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (technician_id, service_variant_id)
);

-- append-only status history (spec §4.5; invariant I24/I25 family)
CREATE TABLE technician_status_history (
  id                uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  technician_id     uuid NOT NULL REFERENCES technicians (id) ON DELETE CASCADE,
  from_status       text NOT NULL,
  to_status         text NOT NULL,
  reason_code       text,
  actor_employee_id uuid REFERENCES employees (id) ON DELETE SET NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_tech_status_history_time ON technician_status_history (technician_id, occurred_at DESC);
CREATE TRIGGER technician_status_history_append_only
  BEFORE UPDATE OR DELETE ON technician_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE technician_shifts (
  id             uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  technician_id  uuid NOT NULL REFERENCES technicians (id) ON DELETE CASCADE,
  store_id       uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_shifts_window CHECK (ends_at > starts_at)
);
CREATE INDEX idx_technician_shifts_active
  ON technician_shifts (technician_id, starts_at, ends_at);

-- ---------------------------------------------------------------------
-- scheduling queue (spec §4.5 + §6)
-- position_key is numeric so explicit reorders can use midpoints (1.5 between
-- 1 and 2). Effective order = (position_key - priority_delta) ASC, tie-broken
-- by eligible_since/id (BUSINESS POLICY — REQUIRES PILOT VALIDATION).
-- ---------------------------------------------------------------------
CREATE TABLE technician_queue_entries (
  id              uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id        uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  technician_id   uuid NOT NULL REFERENCES technicians (id) ON DELETE CASCADE,
  queue_type      text NOT NULL DEFAULT 'ROTATION'
                    CHECK (queue_type IN ('ROTATION', 'REQUESTED', 'RESERVATION',
                                          'MANUAL', 'PRIORITY', 'COMPENSATION')),
  position_key    numeric NOT NULL,
  eligible_since  timestamptz NOT NULL DEFAULT now(),
  priority_delta  integer NOT NULL DEFAULT 0,
  state           text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (state IN ('ACTIVE', 'ASSIGNED', 'REMOVED')),
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- spec §4.5: partial UNIQUE active technician (one ACTIVE entry per technician)
CREATE UNIQUE INDEX uq_tech_queue_one_active
  ON technician_queue_entries (technician_id) WHERE state = 'ACTIVE';
CREATE INDEX idx_tech_queue_store_order
  ON technician_queue_entries (store_id, position_key, eligible_since);

CREATE TABLE technician_queue_events (
  id                uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  queue_entry_id    uuid NOT NULL REFERENCES technician_queue_entries (id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  old_position_key  numeric,
  new_position_key  numeric,
  reason            text,
  actor_id          uuid REFERENCES employees (id) ON DELETE SET NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tech_queue_events_entry ON technician_queue_events (queue_entry_id, occurred_at);
CREATE TRIGGER technician_queue_events_append_only
  BEFORE UPDATE OR DELETE ON technician_queue_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- RBAC extension (append-only; BUSINESS POLICY — REQUIRES PILOT VALIDATION):
--   tech.read   — all 8 system roles (floor visibility, same rationale as room.read)
--   tech.manage — supervisor/manager/boss (act on OTHER people's clock/queue)
-- Self clock-in/out stays identity-gated (own technician record only) — no code needed.
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('tech.read',   'Read technicians within store scope'),
  ('tech.manage', 'Manage other employees'' technician clock and queue state');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'tech.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'tech.manage'
WHERE r.code IN ('role.supervisor', 'role.manager', 'role.boss')
ON CONFLICT DO NOTHING;
