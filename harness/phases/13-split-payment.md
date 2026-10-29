# Phase 13 — Split Payment: online provider adapter + mixed tender (spec §9.4, §13.2)

- **Goal**: take cash AND online money on one order; CAPTURED only from server-verified provider state; paid always equals the sum of captured payments.
- **Scope**: PaymentProvider interface + FakeOnlinePaymentProvider (SIMULATOR — production boot with fake fails closed; real adapters honestly unavailable without merchant credentials); create() opens WECHAT/ALIPAY/… provider-side → PENDING (till not required); cashier capture refuses PENDING; POST /payments/:id/verify (server query, amount re-verified, idempotent); POST /payments/webhook public + HMAC-SHA256 signature (PAYMENT_WEBHOOK_SECRET, timing-safe, amount re-verified, provider txn uniqueness, replay idempotent); shared settleCaptured() for the three entry points; room.current_visit_id cleared on visit close; env production rotation refine + tests; OpenAPI +2 ops.
- **Files**: apps/api/src/payments/{provider.ts,provider.test.ts,payments.service.ts,payments.controller.ts,payments.module.ts,payments.int.test.ts}; packages/config/src/env.*; docs/architecture/state-machines.md; openapi.json.
- **Acceptance**: split tender 300 CASH + 500 WECHAT (verify) + 700 ALIPAY (webhook) → PAID with paid = Σ captured = payable; PENDING capture → 422; forged sig → 403; signed wrong amount → 422 PROVIDER_VERIFICATION_FAILED (server truth, §20 #13); replayed callbacks → replayed:true; settlement drives room.
- **Tests**: provider 3; env 12 (1 new fail-closed); payments.int 9/9; verify EXIT 0 — unit 102×17, integration 105×12.
- **Security**: webhook is public by design — HMAC (timing-safe) authenticates; amount ALWAYS re-verified against the payment row; cross-store 404 on verify; audit actor falls back to SYSTEM (uuid-safe).
- **Migration**: none (provider columns from 0007).
- **Rollback**: revert module (0007 untouched).
- **Risk**: fake provider simulates success only — real provider amount-denial paths exercised via signed-wrong-amount webhook instead; multi-till and wallet method remain Phase 15.
- **DoD / Verification**: `npm run verify` EXIT 0; build-log #58–#60; RC #64–#66.
