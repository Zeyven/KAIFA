-- 0001_foundation_identity.down.sql — reversible on EMPTY/dev databases only.
-- On any environment with real rows: restore from snapshot or write a forward
-- compensating migration; never drop identity tables holding live data.

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS employee_roles;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS store_settings;
DROP TABLE IF EXISTS stores;
DROP TABLE IF EXISTS organizations;
DROP FUNCTION IF EXISTS lanxu_uuidv7();
