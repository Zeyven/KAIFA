-- 0007_payments_cash — reverse

DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS cash_sessions;
DROP FUNCTION IF EXISTS payments_captured_immutable();
