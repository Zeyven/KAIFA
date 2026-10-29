-- 0003 down — drops 0003 objects only (dev/empty DBs; live = snapshot, see runbook).
-- forbid_mutation() belongs to 0002 and is dropped there AFTER this file runs
-- (migration downs execute newest-first).

DROP TRIGGER IF EXISTS technician_queue_events_append_only ON technician_queue_events;
DROP TABLE IF EXISTS technician_queue_events;
DROP TABLE IF EXISTS technician_queue_entries;
DROP TABLE IF EXISTS technician_shifts;
DROP TRIGGER IF EXISTS technician_status_history_append_only ON technician_status_history;
DROP TABLE IF EXISTS technician_status_history;
DROP TABLE IF EXISTS technician_skills;
DROP TABLE IF EXISTS technicians;
DROP TABLE IF EXISTS service_variants;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS service_categories;

DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN ('tech.read', 'tech.manage')
);
DELETE FROM permissions WHERE code IN ('tech.read', 'tech.manage');
