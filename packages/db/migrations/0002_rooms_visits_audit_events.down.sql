-- 0002 down — drops 0002 objects only (dev/empty DBs; live = snapshot, see runbook).

DROP TRIGGER IF EXISTS outbox_events_immutable ON outbox_events;
DROP TABLE IF EXISTS outbox_events;
DROP TRIGGER IF EXISTS security_events_append_only ON security_events;
DROP TABLE IF EXISTS security_events;
DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
DROP TABLE IF EXISTS audit_logs;
DROP FUNCTION IF EXISTS outbox_immutable();
DROP FUNCTION IF EXISTS forbid_mutation();

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS fk_rooms_current_visit;
DROP TABLE IF EXISTS visits;
DROP TABLE IF EXISTS beds;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS areas;
ALTER TABLE stores DROP COLUMN IF EXISTS last_event_seq;

DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN ('room.read', 'room.clean', 'room.maintenance', 'room.disable')
);
DELETE FROM permissions WHERE code IN ('room.read', 'room.clean', 'room.maintenance', 'room.disable');
