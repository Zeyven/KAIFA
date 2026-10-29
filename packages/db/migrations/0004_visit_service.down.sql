-- 0004_visit_service — reverse in dependency order (visits belong to 0002).

DROP TABLE IF EXISTS technician_change_requests;
DROP TABLE IF EXISTS service_extensions;
DROP TRIGGER IF EXISTS trg_service_session_events_append_only ON service_session_events;
DROP FUNCTION IF EXISTS forbid_session_event_mutation;
DROP TABLE IF EXISTS service_session_events;
DROP TABLE IF EXISTS service_sessions;

DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE code IN ('service.read','service.manage','service.terminate')
);
DELETE FROM permissions WHERE code IN ('service.read','service.manage','service.terminate');
