-- 0006_orders — reverse

DROP TABLE IF EXISTS order_adjustments;
ALTER TABLE service_sessions DROP CONSTRAINT IF EXISTS fk_service_sessions_order;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP FUNCTION IF EXISTS order_adjustments_immutable();

DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions WHERE code = 'order.read'
);
DELETE FROM permissions WHERE code = 'order.read';
