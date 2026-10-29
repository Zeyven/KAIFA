-- 0005_devices — reverse

DROP TABLE IF EXISTS devices;

DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN ('device.read','device.manage')
);
DELETE FROM permissions WHERE code IN ('device.read','device.manage');
