-- 0005_devices — device enrollment/binding (spec §4.8 devices, §10.2/§10.4)
-- up: devices (UNIQUE device_code; one ACTIVE device per room) + RBAC
-- down: full reverse
-- Android APK itself is environment-blocked (no JDK/SDK; Google CDN + Maven
-- Central outside egress allowlist) — backend ships regardless.

CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT lanxu_uuidv7(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  store_id           uuid REFERENCES stores (id) ON DELETE RESTRICT,
  room_id            uuid REFERENCES rooms (id) ON DELETE RESTRICT,
  device_type        text NOT NULL DEFAULT 'ROOM_KIOSK'
                     CHECK (device_type IN ('ROOM_KIOSK', 'COUNTER', 'TABLET')),
  -- §10.2 display code (LX-R-9A82K style) — also the device's V1 credential
  device_code        text NOT NULL UNIQUE
                     CHECK (device_code ~ '^LX-[A-Z]-[0-9A-Z]{5}$'),
  platform           text,
  app_version        text,
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED', 'REVOKED')),
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  last_seen_at       timestamptz,
  enrolled_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- binding invariant: a room runs at most one ACTIVE device (§4.8)
  CONSTRAINT chk_device_binding CHECK (
    (status = 'ACTIVE' AND store_id IS NOT NULL AND room_id IS NOT NULL)
    OR status <> 'ACTIVE'
  )
);
CREATE UNIQUE INDEX uq_devices_active_room ON devices (room_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_devices_store ON devices (store_id, status);
CREATE INDEX idx_devices_org ON devices (organization_id);

-- credential rotation bumps version; keep history-free in V1 (documented)
INSERT INTO permissions (code, description) VALUES
  ('device.read',   'View enrolled devices'),
  ('device.manage', 'Bind/unbind/disable room devices (binding console §10.2)')
ON CONFLICT (code) DO NOTHING;

-- read: all eight roles; manage: supervisor/manager/boss (BUSINESS POLICY —
-- REQUIRES PILOT VALIDATION: 钟房 may need bind rights in pilot stores)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'device.read'
WHERE r.code IN ('role.employee','role.frontdesk','role.technician','role.cashier',
                 'role.cleaner','role.supervisor','role.manager','role.boss')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code = 'device.manage'
WHERE r.code IN ('role.supervisor','role.manager','role.boss')
ON CONFLICT DO NOTHING;
