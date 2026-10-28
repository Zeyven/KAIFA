# Threat Model — LanXu StoreOS V1

Scope: Cloud API (`apps/api`), Web (`apps/web`), Edge (`apps/edge`), Room device
(`apps/room-android`), sync channel. Baseline: OWASP API Security Top 10; Master Prompt §16.2.
Review cadence: every phase touching auth/money/sync + Phase 24 (independent red team).

## Assets

| Asset | Impact if compromised |
|---|---|
| Wallet balances / ledger | direct financial loss |
| Payments & refunds | duplicate capture/refund, cash loss |
| Commission entries | payroll fraud |
| Orders & receipts | revenue misstatement |
| RBAC / audit logs | privilege escalation, evidence tampering |
| Device credentials | room hijack, fake kiosk state |
| Customer PII (phone) | privacy breach |
| Store Edge host | full store-op manipulation, sync poisoning |

## Trust boundaries

1. Internet → Cloud API (public).
2. Browser (FrontDesk staff) → Edge/Cloud (authenticated but potentially hostile input).
3. Room device → Edge/Cloud (device credential; the device is physically accessible to guests).
4. Edge → Cloud (sync channel, possibly over untrusted store network).
5. Cloud/Edge → payment provider (webhooks inbound; outbound API).

## Primary threats & controls

| # | Threat (STRIDE-ish) | Control | Verified by |
|---|---|---|---|
| T1 | BOLA/IDOR across store/tenant (API1) | object authorization derived from principal; 404-shape for foreign resources | IDOR regression suite per phase |
| T2 | Broken function-level auth (API5) — front desk calling finance ops | permission guard per route + conditional approval (△ matrix) | RBAC matrix tests |
| T3 | Stolen/leaked JWT | short TTL, refresh rotation (Phase 02 scope: access TTL), scrypt passwords, login rate limit | auth tests |
| T4 | Client fakes "paid" / replays webhook | server-side provider verification, signature + amount/merchant check, idempotent callbacks | payment tests |
| T5 | Double assign / double spend under concurrency | row locks + partial unique indexes + idempotency keys | real-PG concurrency tests |
| T6 | Sync replay/duplication → duplicated money rows | `eventId` dedupe, at-least-once + idempotent apply, no LWW | crash/replay tests |
| T7 | Edge host tampering (physical) | device-to-store binding, signed configs, audit everything, secrets absent on disk by design (env/KMS) | Phase 24 review |
| T8 | Kiosk escape by guest | Device Owner + Lock Task allowlist, no sensitive data in app storage | Phase 09/10 tests (env-blocked now) |
| T9 | Log/audit leakage of secrets/PII | redaction in `packages/observability`; audit payload allowlist | unit redaction tests |
| T10 | SQL injection via filters | parameterized queries only (pg), no string-built SQL | code review + lint rule |
| T11 | DoS via login/payment endpoints | per-IP + per-account rate limits (429) | rate-limit tests |
| T12 | Insider deletes audit trail | DB role has no DELETE on audit/financial tables; append-only defense | integration grant test |
| T13 | Supply chain (npm) | lockfile, `npm audit` gate, pinned majors, minimal deps | CI gate |
| T14 | Misconfigured prod (fake provider, default secret) | boot fail-closed guards | boot tests |

## Explicit non-goals (V1)

Biometrics, custom cryptography beyond standard AEAD/scrypt/JWT, DDoS mitigation (edge/CDN
responsibility), physical security of store hosts (operational runbook item).

## Security gates per phase

New endpoint ⇒ threat row + authorization test. Money path ⇒ idempotency + audit + invariant
tests. Sync change ⇒ replay/dup tests. Phase 24 re-runs this table end-to-end; Blocker/High
must be zero before Production Ready Candidate (spec §20.2, §22).
