# Payment Security — LanXu StoreOS V1

Normative: Master Prompt §13–14. Phases 12–16 implement. Money representation: integer cents
(`bigint`/`BIGINT`) — floats are a Blocker (spec §22.1).

## State machines

```
Payment: CREATED → PENDING → CAPTURED → PARTIALLY_REFUNDED → REFUNDED
                     └→ FAILED | CANCELLED
Refund:  REQUESTED → APPROVED → PROCESSING → COMPLETED | FAILED
```

Only commands move states; guards + permission + audit inside one transaction; no generic
status PATCH.

## Cash (Phase 12)

- `CREATED →(cashier confirms)` → `CAPTURED` with `cash_session_id` + business_date.
- Every cash payment links to an open `cash_sessions` row; `shift_reconciliations` compares
  expected vs counted at shift close. Discrepancy → flagged, audited, never silently adjusted.

## Online (Phase 13, currently EXTERNAL BLOCKER)

Adapter interface: `PaymentProvider { createOrder, query, webhookVerify, refund }`.

- Flow: `Payment.CREATED` → provider create → `PENDING` → **server-verified** signed webhook
  or active query → `CAPTURED`.
- Webhook verification: signature valid, merchant/account match, amount + currency + order
  reference + provider transaction id match, timestamp within window (replay guard).
  Verification failure → 400, no state change, `security_events` row.
- Duplicate callbacks: idempotent — second delivery of same provider txn is ACKed, zero
  extra effect (I10).
- **Client "success" screens are never CAPTURED evidence** (I17). Frontend polls
  `GET /v1/payments/{id}` until terminal state.
- `FakeOnlinePaymentProvider` allowed in dev/test; boot guard **fails closed** if
  `PAYMENT_PROVIDER=fake` while `NODE_ENV=production` (I28).
- Idempotency: every create/refund request carries `Idempotency-Key`;
  `UNIQUE(store_id, idempotency_key)` + replay cache of the stored response.

## Refund (Phase 16)

- Immutable `refunds` row; never DELETE/UPDATE captured `payments`.
- Approval by threshold (`store_settings.approval_config`, dev default tagged
  BUSINESS POLICY — REQUIRES PILOT VALIDATION); approver ≠ requester.
- Provider refund failure → refund `FAILED`, original payment stays `CAPTURED`, operator sees
  explicit retry path.
- Wallet-funded orders refund via ledger reversal entries (principal/bonus ordering reversed
  from consumption order) — no float math, full audit.

## Reconciliation (Phase 22)

| Check | Cadence | Alert |
|---|---|---|
| order.paid == Σ captured payments (− refunds) | hourly + daily | financial P1 |
| provider ledger vs local captured/failed (online methods) | daily | financial P1 |
| wallet balances == Σ ledger deltas | daily | financial P1 |
| cash_sessions expected vs reconciled | per shift | store P1 |

## Secrets

Provider keys come from environment/KMS only — never repo, never client, never audit rows or
logs (redacted by `packages/observability`). Rotations are audited events.
