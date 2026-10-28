# Domain Model — LanXu StoreOS V1

Normative tables: Master Prompt §4. This doc is the navigable summary + policy register.
Money: `BIGINT` cents. IDs: UUIDv7. All business tables carry
`id, organization_id (nullable only where global), store_id (store-scoped), created_at,
updated_at, version (optimistic where mutated)`.

## Bounded groups (by module)

| Module | Tables (spec §4) | Mutability rule |
|---|---|---|
| Organization | organizations, stores, store_settings, areas, rooms, beds | config rows versioned; room state machine only via commands |
| Auth/Employee/RBAC | users, employees, roles, permissions, employee_roles, role_permissions | permission changes audited |
| Catalog | service_categories, services, service_variants, products, price_books, price_book_items | order rows never re-read live prices (snapshot) |
| Technician | technicians, technician_skills, technician_status_history, technician_shifts, technician_queue_entries, technician_queue_events | history/queue events append-only |
| Visit/Service | visits, service_sessions, service_session_events, service_extensions, technician_change_requests | events append-only; visits partial-unique active per room |
| Order/Payment | orders, order_items, order_adjustments, payments, payment_attempts, refunds, cash_sessions, shift_reconciliations | money append-only; corrections via new rows |
| Customer/Member | customers, memberships, wallets, wallet_ledger_entries | ledger append-only; balance derived+materialized, never free-standing |
| Commission | commission_rules, commission_rule_versions, commission_entries, commission_adjustments | used rule versions immutable; entries fixed, adjustments additive |
| Device/Approval/Audit/Sync | devices, approval_requests, approval_actions, audit_logs, security_events, outbox_events, inbox_events, sync_checkpoints | append-only; audit not deletable by app role |

## Key relations

```
organizations 1─* stores 1─* { areas 1─* rooms 1─* beds }
stores 1─* visits 1─* service_sessions 1─* service_session_events
visits 1─* orders 1─* { order_items, order_adjustments, payments 1─* payment_attempts, payments 1─* refunds }
payments N─1 cash_sessions (cash method)
customers 1─* memberships 1─* wallets 1─* wallet_ledger_entries
employees 1─1 (store) technicians 1─* queue entries / commission_entries
service_sessions 1─* commission_entries (N?1 with rule_version immutable)
devices *─1 rooms (one active device per room)
```

## Identity & privacy

- `customers.phone_hash` (HMAC-SHA256 with server pepper) for lookup; `phone_encrypted`
  (AES-256-GCM, key from KMS/env) for display; logs show masked `138****1234` only.
- `users.password_hash` = scrypt (N=2^15, r=8, p=1) + per-user salt, opaque format
  `scrypt$N$r$p$salt$hash`. Never logged.

## Versioning & concurrency

- Mutable aggregates carry `version` incremented on every command; commands send expected
  version → mismatch = 409 `VERSION_CONFLICT` (optimistic). Money hot rows (wallet,
  queue entry, payment) additionally use `SELECT … FOR UPDATE` inside the command txn.

## Policy register (unfrozen — Master Prompt §21)

| Policy | Dev default (labeled) | Needs |
|---|---|---|
| Scheduling weights | spec §6.3 table (queue 1000 / idle 100 / comp 300 / skill 30 / pref 20 / reservation −500 / overtime −100) | real store SOP → `BUSINESS POLICY — REQUIRES PILOT VALIDATION` |
| 点钟下牌 / 退钟补牌 / 加钟轮牌 | config flags, default: 点钟 keeps queue position (dev default) | real store SOP |
| Commission formulas | declarative engine FIXED/PERCENT/PER_MINUTE/TIERED; dev fixtures only | real wage samples |
| Discount/refund approval thresholds | `store_settings.approval_config.thresholds_cents`, dev defaults (e.g. discount ≥ ¥500 needs approval) | pilot sign-off |
| Payment provider | FakeOnlinePaymentProvider in dev/test; production boot FAILS on fake (fail closed) | real merchant credentials (EXTERNAL BLOCKER) |
| Prepaid/wallet compliance | principal/bonus split ledger implemented; expiry rules config-driven | operating-city legal review |

## Invariants that constrain the model

See `invariants.md` (DB + service level). Notable modeling consequences:

1. "One active visit per room" and "one active session per technician" are **partial unique
   indexes**, not app-only checks.
2. Order money columns are always `>= 0`; refunds/refusals are separate rows so that paid ≥
   captured arithmetic stays provable.
3. Wallet has both materialized balances and append-only deltas; nightly reconciliation
   compares `balance == SUM(delta)`.
