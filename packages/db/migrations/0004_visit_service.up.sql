-- 0004_visit_service — ServiceSession domain (spec §4.6, invariants §4.9)
-- NOTE: visits table is owned by 0002 (status ACTIVE/CLOSED, one ACTIVE per room).
-- up: service_sessions (one active per technician),
--      append-only service_session_events, service_extensions, technician_change_requests
--      + permissions service.read / service.manage / service.terminate
-- down: full reverse in dependency order.

-- ===================== permissions (business defaults) =====================
-- BUSINESS POLICY — REQUIRES PILOT VALIDATION (same delivery as 0001/0002/0003).

-- ===================== service sessions =====================
CREATE TABLE service_sessions (
  id                   uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id             uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  visit_id             uuid NOT NULL REFERENCES visits(id) ON DELETE RESTRICT,
  order_id             uuid, -- Phase 08: orders FK added there
  room_id              uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  bed_id               uuid, -- deferred: bed resource model
  service_variant_id   uuid NOT NULL REFERENCES service_variants(id) ON DELETE RESTRICT,
  technician_id        uuid REFERENCES technicians(id) ON DELETE SET NULL,
  assignment_type      text NOT NULL DEFAULT 'ROTATION'
                       CHECK (assignment_type IN
                         ('ROTATION','REQUESTED','RESERVATION','MANUAL','PRIORITY','COMPENSATION')),
  status               text NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN
                         ('DRAFT','ASSIGNED','ACKNOWLEDGED','ARRIVED','STARTED','ENDING_SOON',
                          'COMPLETED','CANCELLED','REJECTED','TERMINATED')),
  duration_minutes     integer NOT NULL CHECK (duration_minutes > 0),
  scheduled_end_at     timestamptz,
  started_at           timestamptz,
  ended_at             timestamptz,
  price_cents          bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  queue_position_snapshot integer, -- §4.6 queue snapshot (fairness audit)
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by           uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Invariant §4.9: at most one running session per technician.
CREATE UNIQUE INDEX uq_service_sessions_active_technician
  ON service_sessions (technician_id)
  WHERE technician_id IS NOT NULL
    AND status IN ('DRAFT','ASSIGNED','ACKNOWLEDGED','ARRIVED','STARTED','ENDING_SOON');
CREATE INDEX idx_service_sessions_store_status ON service_sessions (store_id, status);
CREATE INDEX idx_service_sessions_visit ON service_sessions (visit_id);
CREATE INDEX idx_service_sessions_technician ON service_sessions (technician_id);
CREATE INDEX idx_service_sessions_room ON service_sessions (room_id, status);
-- price snapshot follows the bigint-cents convention
ALTER TABLE service_sessions
  ADD CONSTRAINT chk_service_sessions_price_cents_bigint CHECK (price_cents >= 0);

-- ===================== session events (append-only) =====================
CREATE TABLE service_session_events (
  id                 uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  service_session_id uuid NOT NULL REFERENCES service_sessions(id) ON DELETE RESTRICT,
  event_type         text NOT NULL,
  actor_type         text NOT NULL CHECK (actor_type IN ('STAFF','CUSTOMER','SYSTEM')),
  actor_id           uuid,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_service_session_events_session
  ON service_session_events (service_session_id, occurred_at);
CREATE OR REPLACE FUNCTION forbid_session_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'service_session_events is append-only'
    USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_service_session_events_append_only
  BEFORE UPDATE OR DELETE ON service_session_events
  FOR EACH ROW EXECUTE FUNCTION forbid_session_event_mutation();

-- ===================== service extensions =====================
CREATE TABLE service_extensions (
  id                 uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  service_session_id uuid NOT NULL REFERENCES service_sessions(id) ON DELETE RESTRICT,
  minutes            integer NOT NULL CHECK (minutes > 0),
  price_delta_cents  bigint NOT NULL DEFAULT 0 CHECK (price_delta_cents >= 0),
  approved_by        uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_by         uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_extensions_session ON service_extensions (service_session_id);

-- ===================== technician change requests =====================
CREATE TABLE technician_change_requests (
  id                     uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  store_id               uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  session_id             uuid NOT NULL REFERENCES service_sessions(id) ON DELETE RESTRICT,
  from_technician_id     uuid REFERENCES technicians(id) ON DELETE SET NULL,
  requested_technician_id uuid REFERENCES technicians(id) ON DELETE SET NULL,
  reason_code            text NOT NULL,
  status                 text NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by           uuid REFERENCES employees(id) ON DELETE SET NULL,
  approved_by            uuid REFERENCES employees(id) ON DELETE SET NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz
);
CREATE INDEX idx_tech_change_requests_session ON technician_change_requests (session_id, status);

-- ===================== permissions =====================
INSERT INTO permissions (code, description) VALUES
  ('service.read',     'View visits and service sessions'),
  ('service.manage',   'Create and run service session lifecycle commands'),
  ('service.terminate','Terminate a started service session (exception path)')
ON CONFLICT (code) DO NOTHING;

-- All eight roles may read service state; manage = frontdesk/supervisor/manager/boss;
-- terminate = supervisor/manager/boss only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'service.read'
WHERE r.code IN ('role.employee','role.frontdesk','role.technician','role.cashier',
                 'role.cleaner','role.supervisor','role.manager','role.boss')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'service.manage'
WHERE r.code IN ('role.frontdesk','role.supervisor','role.manager','role.boss')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'service.terminate'
WHERE r.code IN ('role.supervisor','role.manager','role.boss')
ON CONFLICT DO NOTHING;
