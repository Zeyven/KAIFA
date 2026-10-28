# Invariants — LanXu StoreOS V1 (hard, test-enforced)

Source: Master Prompt §4.9, §20, §22. A violation is a release **Blocker** unless explicitly
reclassified by red-team review. Every invariant below must have at least one test (unit or
real-PG integration) once its phase lands; the test column is the audit trail.

## Identity & tenancy

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I1 | All business PKs are UUIDv7 (time-ordered, version nibble 7) | DB default `lanxu_uuidv7()` + app `newUuidv7()` | unit (format/order) + integration (DB default) |
| I2 | Every store-scoped row belongs to exactly one store; every cross-store read is authorized server-side from the principal | repository scoping + guards | integration: cross-store IDOR (Phase 02+) |
| I3 | Cross-organization access always rejected (403/404, no existence leak) | object authorization | integration (Phase 02+) |

## Rooms / technicians / scheduling

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I4 | At most ONE active visit per room | partial unique index `visits_active_room` | integration (Phase 06) |
| I5 | At most ONE active service session per technician | partial unique index `service_sessions_active_technician` | integration (Phase 05/06) |
| I6 | Room state machine only: `IN_SERVICE → VACANT_CLEAN` forbidden; must pass WAITING_CHECKOUT → DIRTY → CLEANING → VACANT_CLEAN | domain transition table + API commands (no PATCH status) | unit all legal/illegal transitions (Phase 03) |
| I7 | Technician "complete → recompute", never unconditional AVAILABLE | domain recompute function | unit (Phase 04) |
| I8 | Concurrent assign to the same technician: exactly one txn commits | `SELECT … FOR UPDATE` + unique active-session index | real-PG concurrency test (Phase 05) |

## Money & financial integrity

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I9 | No float/double ever represents RMB as authority: domain `bigint` cents, DB `BIGINT`, wire integer cents | types + code review + grep gate | unit money module |
| I10 | One provider transaction captured at most once | `UNIQUE(provider, provider_transaction_id)` + idempotency | integration (Phase 12/13) |
| I11 | Same Idempotency-Key ⇒ same single business result | `UNIQUE(store_id, idempotency_key)` + lookup-first | integration |
| I12 | Wallet balance never negative; balance changes only via ledger rows | `CHECK (balance >= 0)` + single writer path in txn | integration + concurrency (Phase 15) |
| I13 | `wallet.principal_balance == SUM(principal_delta)` (bonus likewise) at reconciliation | nightly job, high-severity alert | reconciliation test (Phase 22) |
| I14 | Captured payments immutable; refunds are new append-only rows; failed refund leaves payment CAPTURED | schema (no update paths) + commands | integration (Phase 16) |
| I15 | Orders/payments/refunds mathematically reconcile: order.paid == Σ successful payments; refunded == Σ completed refunds | derivation + reconciliation job | property/integration (Phase 22) |
| I16 | Order line items keep price/name snapshot at sale time; catalog drift never rewrites history | insert-time snapshot columns | unit/integration (Phase 11) |
| I17 | Client-reported "paid" is never CAPTURED evidence | server-verified provider callbacks/query only | unit (fake provider) + fail-closed prod guard |

## Commission

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I18 | Commission entries reference an immutable rule version; used versions cannot be edited | `UPDATE` blocked (trigger or service-level immutability check) | integration (Phase 17) |
| I19 | Every commission entry derives from a service session or an explicit adjustment with approver | FK + service validation | integration |
| I20 | Corrections use `commission_adjustments`, never in-place edits | no update path to `amount_cents` | integration |

## Sync & offline

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I21 | Business write + domain event + outbox row commit atomically; no publish-then-commit or commit-then-publish double write | single txn in every command service | crash simulation (Phase 20) |
| I22 | Cloud outage never loses store business events; duplicates are deduped by `eventId` | outbox/inbox + `UNIQUE(event_id)` | replay/dup tests (Phase 20/21) |
| I23 | Payment/Wallet/ServiceSession/Scheduling/Commission/Refund conflict resolution is never last-write-wins | sync design; conflict → reject/queue manual | review + tests (Phase 21) |

## Auth / audit / device

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I24 | All high-risk actions write audit rows in the same txn as the mutation | audit helper in command path | integration |
| I25 | Application role cannot DELETE from audit/financial history tables | GRANT model (no DELETE) + trigger defense | integration: delete attempt fails |
| I26 | Secrets/tokens/passwords/full PANs never appear in audit payloads or logs | redaction allowlist in `packages/observability` | unit redaction tests |
| I27 | Device credential is bound to store/room; backend never trusts client-supplied roomId for device traffic | device identity → room mapping server-side | integration (Phase 09) |
| I28 | Production refuses to boot with fake payment provider or default dev secrets | boot-time guard, fail closed | unit + boot test |

## Definition

Invariant text here is normative. Code may not weaken a row without an ADR in `docs/adr/`
recording rationale, compensating control, and red-team sign-off.
