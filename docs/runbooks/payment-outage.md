# Runbook — Payment Outage / Provider Failure

Applies to: online provider timeouts, webhook delivery failures, refund processing failures.
Cash path is unaffected (local authority) — keep selling.

## Symptoms

- `payment.failure_rate` spikes; `PROVIDER_VERIFICATION_FAILED` / 503 responses.
- Payments stuck in `PENDING` beyond expected window.
- Provider console degraded (external status page).

## Decision table

| Situation | Action |
|---|---|
| Provider create-order timeout | Payment stays `CREATED/PENDING`; client retries with SAME Idempotency-Key; never mark CAPTURED locally |
| Provider down, unknown outcome | Offer cashier: wait / 现金结算; active query when provider returns; never blind-capture |
| Webhooks not arriving | Polling reconciler queries provider by payment reference → applies verified state (idempotent) |
| Suspected double capture | Reconciliation alerts; DO NOT auto-refund — approval flow + provider check first (spec §22.1 duplicate payments are Blocker-class) |
| Refund failing | refund row = FAILED, payment remains CAPTURED; retry via provider with same refund idempotency key |

## Restore normal ops

1. Provider healthy → pending queue drains; verify `payment.pending_count → 0`.
2. Run reconciliation job for the outage window (local vs provider).
3. Confirm no payment stuck > SLA; manually resolve stragglers with audit.

## Hard rules (from spec §13)

- Client-reported success is never authority (I17).
- Fake provider in production → process refuses to boot (I28).
- Provider callbacks: verify signature/amount/merchant/reference; duplicates are no-ops (I10).

## EXTERNAL BLOCKER note

Real merchant credentials are not yet provisioned (PLANS.md). Until then, phases 12–13 use
`FakeOnlinePaymentProvider` in dev/test only, and this runbook's provider-specific commands
remain `NOT VERIFIED`.
