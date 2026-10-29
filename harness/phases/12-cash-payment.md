# Phase 12 — Cash Payment + Cash Session Reconciliation (spec §13.1, §4.7 payments, §5.4)

- **Goal**: take money correctly — cashier confirm captures in one tx, bills settle to PAID mathematically, till 对账 exact, financial rows immutable.
- **Scope**: migration 0007 (cash_sessions + payments + immutability triggers); domain payment-state; PaymentsModule {POST /payments w/ mandatory Idempotency-Key + replay/conflict semantics, capture (payment+order+events atomic; idempotent), GET /payments, cash-sessions find-open/close/list with expected=count(float+captured) and variance snapshots}; PAID settlement → visit CLOSED + room ORDER_PAID→DIRTY (+ cleaning cycle proven back to VACANT_CLEAN); goods-only OCCUPIED_WAITING_SERVICE ORDER_PAID edge (BUSINESS POLICY gap-fill); OpenAPI +6 ops.
- **Files**: packages/db/migrations/0007_*; packages/domain/src/payment-state.*; apps/api/src/payments/*; room-state.ts (+tests); contracts errors (PAYMENT_EXCEEDS_DUE/CASH_SESSION_REQUIRED 422); openapi.json; state-machines.md registry.
- **Acceptance**: §20 #3 (provider txn unique), #4 (one result per idempotency key incl. conflict on payload change), #7 (capture = order math + till expected reconcile exactly); captured money can never be edited/reverted/deleted (23001×3 tested); non-CASH fail-closed until Phase 13; cross-store 404.
- **Tests**: payment-state 6; payments.int 8/8; full integration 104/104×12; verify EXIT 0 (unit 98×16).
- **Security**: order.checkout for create/capture/till ops, order.read for reads; store-scoped everything; till must be OPEN (locks till row FOR UPDATE); capture double-confirm idempotent; audit rows for payment.created/captured + cash_session.opened/closed (+variance).
- **Migration**: 0007 additive; down drops tables + trigger function.
- **Rollback**: down + module revert (orders untouched by rollback; captured history preserved by design).
- **Risk**: CASH_SESSION auto-pick uses latest OPEN till (multi-till parallel operation out of V1 scope); visit close uses ORDER_PAID soft-skip — a room moved by other paths keeps its state (documented).
- **DoD / Verification**: `npm run verify` EXIT 0; build-log #54–#57; root causes #60–#63.
