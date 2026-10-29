-- 0002_rooms_visits_audit — room domain tables + visit core + audit/outbox backbone
-- Spec: §4.2 areas/rooms/beds · §4.6 visits (core) · §4.9 audit + outbox · §5.1 room machine.
--
-- Lock risk: LOW (ADD of new tables/columns only). Compatibility: additive —
--   Phase 00/01 code unaffected. Rollback: reversible (drops new objects only).
-- Notes:
--   * visits.customer_id has NO FK yet — customers land in 0007 (expand/contract);
--     FK added by that migration.
--   * outbox_events is THE per-store event stream: store_seq allocated transactionally
--     via stores.last_event_seq (feeds WebSocket replay Phase 18 + Cloud inbox Phase 20).
--   * audit_logs / security_events are append-only at DB level (triggers = invariant I25).

-- ---------------------------------------------------------------------------
-- Store event sequence column (used by appendStoreEvent inside command txns)
-- ---------------------------------------------------------------------------
ALTER TABLE stores ADD COLUMN last_event_seq bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Areas / Rooms / Beds (spec §4.2)
-- ---------------------------------------------------------------------------
CREATE TABLE areas (
  id          uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id    uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_areas_store ON areas (store_id, status);

CREATE TABLE rooms (
  id                uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id          uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  area_id           uuid REFERENCES areas (id) ON DELETE SET NULL,
  code              text NOT NULL,
  name              text NOT NULL DEFAULT '',
  room_type         text NOT NULL DEFAULT 'STANDARD',
  capacity          integer NOT NULL DEFAULT 2 CHECK (capacity > 0),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  operational_state text NOT NULL DEFAULT 'VACANT_CLEAN'
                      CHECK (operational_state IN (
                        'VACANT_CLEAN', 'RESERVED', 'OCCUPIED_WAITING_SERVICE',
                        'IN_SERVICE', 'WAITING_CHECKOUT', 'DIRTY', 'CLEANING',
                        'MAINTENANCE', 'DISABLED')),
  current_visit_id  uuid,
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_store_code_key UNIQUE (store_id, code)
);
CREATE INDEX idx_rooms_store_state ON rooms (store_id, operational_state);

CREATE TABLE beds (
  id          uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  room_id     uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beds_room_code_key UNIQUE (room_id, code)
);

-- ---------------------------------------------------------------------------
-- Visits — core columns only (customer FK added in 0007)
-- Invariant I4: at most ONE active visit per room (partial unique).
-- ---------------------------------------------------------------------------
CREATE TABLE visits (
  id             uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id       uuid NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  room_id        uuid NOT NULL REFERENCES rooms (id) ON DELETE RESTRICT,
  customer_id    uuid,                     -- FK added in 0007 (customers)
  guest_count    integer NOT NULL DEFAULT 1 CHECK (guest_count > 0),
  status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'CLOSED', 'CANCELLED')),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  opened_by      uuid REFERENCES employees (id) ON DELETE SET NULL,
  business_date  date NOT NULL,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visits_closed_requires_time CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_visits_active_room ON visits (room_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_visits_store_date ON visits (store_id, business_date);

ALTER TABLE rooms
  ADD CONSTRAINT fk_rooms_current_visit FOREIGN KEY (current_visit_id)
  REFERENCES visits (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Audit / security (spec §16.1, invariants I24–I26)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  store_id       uuid REFERENCES stores (id) ON DELETE RESTRICT,
  actor_type     text NOT NULL CHECK (actor_type IN ('USER', 'EMPLOYEE', 'DEVICE', 'SYSTEM')),
  actor_id       uuid,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    uuid,
  request_id     text,
  before         jsonb,
  after          jsonb,
  reason         text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_store_time ON audit_logs (store_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs (actor_id, created_at DESC);

CREATE TABLE security_events (
  id              uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id uuid,
  store_id        uuid,
  event_type      text NOT NULL,
  actor_hint      text,
  ip              text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_security_events_time ON security_events (created_at DESC);
CREATE INDEX idx_security_events_type ON security_events (event_type, created_at DESC);

-- Append-only defense (application DB role additionally gets no UPDATE/DELETE in
-- managed environments; trigger is the portable belt, invariant I25).
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (invariant I25)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Outbox = per-store committed event stream (spec §8 storeSeq, §12.2 outbox).
-- Payload/history immutable; only published_at may change (sync worker, Phase 20).
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  event_id       uuid NOT NULL DEFAULT lanxu_uuidv7(),
  store_id       uuid NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  store_seq      bigint NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL DEFAULT 'CLOUD' CHECK (source IN ('CLOUD', 'EDGE')),
  published_at   timestamptz,
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT outbox_store_seq_key UNIQUE (store_id, store_seq),
  CONSTRAINT outbox_event_id_key UNIQUE (event_id)
);
CREATE INDEX idx_outbox_unpublished ON outbox_events (store_id, published_at)
  WHERE published_at IS NULL;

CREATE FUNCTION outbox_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.store_seq IS DISTINCT FROM OLD.store_seq
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'outbox_events history is immutable (only published_at may change)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_immutable
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_immutable();

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Additional permissions required by room operations (append-only RBAC extension)
-- Codes + grants derived from §11 role matrix + floor visibility.
-- BUSINESS POLICY — REQUIRES PILOT VALIDATION: room.clean/maintenance/disable
-- role placement (clean: front/cashier/supervisor/manager/boss; maintenance:
-- supervisor+; disable: manager/boss) is a conservative default.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('room.read',        'Read room floor state within store scope'),
  ('room.clean',       'Start/complete room cleaning'),
  ('room.maintenance', 'Start/end room maintenance'),
  ('room.disable',     'Enable/disable a room');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'room.read'
ON CONFLICT DO NOTHING;

-- one statement per capability: an exclusive CASE would place each role in
-- only ONE branch and silently starve manager/boss of maintenance/disable
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'room.clean'
WHERE r.code IN ('role.frontdesk', 'role.cashier', 'role.supervisor', 'role.manager', 'role.boss')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'room.maintenance'
WHERE r.code IN ('role.supervisor', 'role.manager', 'role.boss')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'room.disable'
WHERE r.code IN ('role.manager', 'role.boss')
ON CONFLICT DO NOTHING;
