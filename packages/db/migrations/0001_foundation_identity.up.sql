-- 0001_foundation_identity — organizations / stores / identity / RBAC
-- Spec: Master Prompt §4.1 global conventions, §4.2 Organization, §4.3 Identity/RBAC.
--
-- Lock risk: LOW (empty tables on fresh installs; CREATE TABLE/INDEX only).
-- Compatibility window: safe to apply with any Phase 00+ code (no destructive changes).
-- Rollback: reversible via 0001_foundation_identity.down.sql (drops schema objects;
--   on any environment with real rows, restore from snapshot instead — never down live).
-- Notes:
--   * All PKs default to lanxu_uuidv7() (ADR-0004) — gen_random_uuid() yields v4, banned.
--   * Role code uniqueness: partial unique indexes handle system roles (org NULL) where
--     plain UNIQUE(col1, col2) would treat NULLs as distinct.

-- ---------------------------------------------------------------------------
-- UUIDv7 generator (48-bit clock_timestamp ms | ver 7 | rand_a | variant 10 | rand_b)
-- No extensions required. Same-ms ordering is best-effort; strict ordering uses
-- dedicated sequence columns (e.g. store_seq), never ID lexicography alone.
-- ---------------------------------------------------------------------------
CREATE FUNCTION lanxu_uuidv7() RETURNS uuid
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  ts_hex text := lpad(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0');
  ver_a_hex text := lpad(to_hex(28672 + floor(random() * 4096)::bigint), 4, '0');
  -- 16 hex for (variant '10' + 2 random bits + 60 random bits): nibble 8..b then 15 hex.
  -- NOTE: variant lives in bits 63..62 of the second qword — building it as a signed
  -- bigint would overflow (2^63), so it is assembled from hex digits instead.
  var_hex text :=
    lpad(to_hex(8 + floor(random() * 4)::bigint), 1, '0')
    || substr(
         lpad(to_hex(floor(random() * 4503599627370496)::bigint), 13, '0')
         || lpad(to_hex(floor(random() * 4503599627370496)::bigint), 13, '0'),
         1, 15);
  v_hex text;
BEGIN
  v_hex := ts_hex || ver_a_hex || var_hex;
  RETURN (
    substr(v_hex, 1, 8) || '-' || substr(v_hex, 9, 4) || '-' ||
    substr(v_hex, 13, 4) || '-' || substr(v_hex, 17, 4) || '-' || substr(v_hex, 21, 12)
  )::uuid;
END;
$$;

COMMENT ON FUNCTION lanxu_uuidv7() IS
  'RFC 9562 UUIDv7 default for business primary keys (ADR-0004, invariant I1)';

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  name        text NOT NULL,
  code        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  timezone    text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_code_key UNIQUE (code)
);

CREATE TABLE stores (
  id                       uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  code                     text NOT NULL,
  name                     text NOT NULL,
  timezone                 text NOT NULL DEFAULT 'Asia/Shanghai',
  business_date_cutoff_time time NOT NULL DEFAULT TIME '04:00',
  currency                 text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  status                   text NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  address_text             text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_org_code_key UNIQUE (organization_id, code)
);
CREATE INDEX idx_stores_organization_status ON stores (organization_id, status);

CREATE TABLE store_settings (
  store_id           uuid PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
  settings_version   integer NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  scheduling_config  jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(scheduling_config) = 'object'),
  payment_config     jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(payment_config) = 'object'),
  room_config        jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(room_config) = 'object'),
  receipt_config     jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(receipt_config) = 'object'),
  approval_config    jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(approval_config) = 'object'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE store_settings IS
  'Per-store config JSONB. NEVER stores secrets (spec §4.2). Business-policy defaults are
   tagged BUSINESS POLICY — REQUIRES PILOT VALIDATION at the application layer.';

-- ---------------------------------------------------------------------------
-- Identity / RBAC (spec §4.3)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  username           text NOT NULL,
  phone_hash         text,
  phone_encrypted    text,
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED')),
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_org_username_key UNIQUE (organization_id, username)
);
CREATE INDEX idx_users_org_status ON users (organization_id, status);
CREATE UNIQUE INDEX uq_users_phone_hash
  ON users (organization_id, phone_hash) WHERE phone_hash IS NOT NULL;

CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  store_id          uuid NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
  user_id           uuid REFERENCES users (id) ON DELETE SET NULL,
  employee_no       text NOT NULL,
  display_name      text NOT NULL,
  employee_type     text NOT NULL
                      CHECK (employee_type IN ('FRONTDESK', 'CASHIER', 'CLOCKROOM', 'TECHNICIAN',
                                               'SUPERVISOR', 'MANAGER', 'FINANCE', 'BOSS',
                                               'CLEANER', 'OTHER')),
  employment_status text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (employment_status IN ('ACTIVE', 'LEFT', 'SUSPENDED')),
  joined_at         date NOT NULL DEFAULT current_date,
  left_at           date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_store_no_key UNIQUE (store_id, employee_no),
  CONSTRAINT employees_left_requires_date CHECK (employment_status <> 'LEFT' OR left_at IS NOT NULL),
  CONSTRAINT employees_left_not_before_join CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE INDEX idx_employees_store_status ON employees (store_id, employment_status);
CREATE INDEX idx_employees_user ON employees (user_id) WHERE user_id IS NOT NULL;

-- Roles: organization_id NULL ⇒ system role (global). Two partial uniques because
-- UNIQUE(organization_id, code) would not dedupe system roles (NULLs distinct).
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  system_role     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_system_requires_no_org
    CHECK ((organization_id IS NULL) = system_role),
  CONSTRAINT roles_org_code_key UNIQUE (organization_id, code)
);
CREATE UNIQUE INDEX uq_roles_system_code ON roles (code) WHERE organization_id IS NULL;

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  code        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_code_key UNIQUE (code)
);

CREATE TABLE employee_roles (
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES employees (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, role_id, store_id)
);
CREATE INDEX idx_employee_roles_store ON employee_roles (store_id);
CREATE INDEX idx_employee_roles_role ON employee_roles (role_id);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

-- ---------------------------------------------------------------------------
-- Seed: permission registry + system roles (spec §11 matrix)
-- Codes are stable strings; application maps capability → permission code.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('auth.login',            'Authenticate and hold a session'),
  ('room.open',             'Open a visit into a room'),
  ('room.move',             'Move a visit between rooms'),
  ('schedule.assign',       'Normal scheduling / queue assignment'),
  ('schedule.assign.force', 'Force / override scheduling (may require approval)'),
  ('service.self_start_stop','Start/stop own service sessions'),
  ('service.time_override', 'Override service duration (may require approval)'),
  ('order.checkout',        'Settle an order'),
  ('order.discount',        'Apply discounts (thresholds may require approval)'),
  ('refund.request',        'Request a refund'),
  ('refund.approve',        'Approve a refund (thresholds may require approval)'),
  ('wallet.adjust',         'Adjust member wallet (may require approval)'),
  ('commission.adjust',     'Adjust commission entries'),
  ('rbac.manage',           'Manage roles and grants'),
  ('audit.read',            'Read audit logs');

INSERT INTO roles (organization_id, code, name, system_role) VALUES
  (NULL, 'role.frontdesk',  '前台',   true),
  (NULL, 'role.cashier',    '收银',   true),
  (NULL, 'role.clockroom',  '钟房',   true),
  (NULL, 'role.technician', '技师',   true),
  (NULL, 'role.supervisor', '主管',   true),
  (NULL, 'role.manager',    '店长',   true),
  (NULL, 'role.finance',    '财务',   true),
  (NULL, 'role.boss',       '老板',   true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY ((
  -- role.frontdesk: open/move/assign/checkout/discount(△)/refund request
  CASE WHEN r.code = 'role.frontdesk' THEN
    ARRAY['auth.login','room.open','room.move','schedule.assign','order.checkout',
          'order.discount','refund.request']
  -- role.cashier: open + full cashier duties
  WHEN r.code = 'role.cashier' THEN
    ARRAY['auth.login','room.open','order.checkout','order.discount','refund.request']
  -- role.clockroom: normal + forced scheduling (force gated by approval △)
  WHEN r.code = 'role.clockroom' THEN
    ARRAY['auth.login','schedule.assign','schedule.assign.force']
  -- role.technician: own start/stop only
  WHEN r.code = 'role.technician' THEN
    ARRAY['auth.login','service.self_start_stop']
  -- role.supervisor: everything except rbac/wallet/commission management
  WHEN r.code = 'role.supervisor' THEN
    ARRAY['auth.login','room.open','room.move','schedule.assign','schedule.assign.force',
          'service.self_start_stop','service.time_override','order.checkout','order.discount',
          'refund.request','refund.approve','audit.read']
  -- role.manager: full store operations incl. rbac + commission
  WHEN r.code = 'role.manager' THEN
    ARRAY['auth.login','room.open','room.move','schedule.assign','schedule.assign.force',
          'service.self_start_stop','service.time_override','order.checkout','order.discount',
          'refund.request','refund.approve','wallet.adjust','commission.adjust',
          'rbac.manage','audit.read']
  -- role.finance: money-sensitive duties + audit
  WHEN r.code = 'role.finance' THEN
    ARRAY['auth.login','refund.request','refund.approve','wallet.adjust','commission.adjust',
          'audit.read']
  -- role.boss: everything
  WHEN r.code = 'role.boss' THEN
    ARRAY['auth.login','room.open','room.move','schedule.assign','schedule.assign.force',
          'service.self_start_stop','service.time_override','order.checkout','order.discount',
          'refund.request','refund.approve','wallet.adjust','commission.adjust',
          'rbac.manage','audit.read']
END)::text[]);
