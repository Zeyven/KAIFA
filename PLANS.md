# PLANS.md — LanXu StoreOS V1

Single source of truth for phase state. Details per phase: `harness/phases/NN-*.md`
(template: Master Prompt §19.1). Never track long-lived state only in chat.

Status vocabulary: `TODO` · `IN PROGRESS` · `IMPLEMENTED BUT NOT VERIFIED` · `DONE` (all DoD
gates executed with recorded evidence) · `BLOCKED` (external dependency — name it).

## Phase board (spec §19)

| Phase | Name | Status | Notes |
|---|---|---|---|
| 00 | Repository Foundation | DONE | gates 2026-10-28: install/format/lint/typecheck/unit(36)/integration(PG18×3)/openapi/build/audit-0 + live smoke — see harness/build-log.md |
| 01 | Database Foundation | DONE | 0001 org/store/identity/RBAC + uuidv7 fn; up/down/checksum/concurrent gates on real PG18; readiness 503→200 — verify exit 0 |
| 02 | Authentication & Authorization | DONE | scrypt+JWT(HS256 pin), global guard public→JWT→store-scope→permissions, rate limit 5/60s, security_events, IDOR 404 — auth.int 10/10, verify exit 0 2026-10-29 |
| 03 | Room Domain | DONE | 0002 rooms/visits/audit+outbox (append-only 23001), §5.1 machine, open/move/cleaning/maintenance/disable commands (tx+FOR UPDATE+version 409) — rooms.int 12/12 + migrations chain 9/9 |
| 04 | Technician Domain | DONE | technician/skill/shift/status/history; queue lifecycle |
| 05 | Scheduling | DONE | queue/recommend/assign/concurrency (§6.4 race green) |
| 06 | Visit / ServiceSession | DONE | sessions lifecycle + room/tech sync; visit via room open |
| 07 | FrontDesk Room Board | TODO | first real web vertical slice on live API |
| 08 | Clock Board | TODO | queue/recommend UI + explainability |
| 09 | Android Enrollment | TODO | device enrollment/binding (needs Android env → likely BLOCKED here) |
| 10 | Android Room Core | TODO | kiosk flow (env-blocked) |
| 11 | Order Engine | TODO | order/items/pricing/discount/checkout snapshot |
| 12 | Cash Payment | TODO | cash sessions + reconciliation |
| 13 | Split Payment | TODO | multi-payment allocations |
| 14 | Customer / Member | TODO | lookup/privacy (hash+encrypt phone) |
| 15 | Wallet Ledger | TODO | principal/bonus append-only ledger, concurrency |
| 16 | Refund | TODO | approval + provider refund + reversal + audit |
| 17 | Commission | TODO | versioned declarative rules, immutable history |
| 18 | WebSocket | TODO | storeSeq/replay/reconnect/snapshot fallback |
| 19 | Edge Runtime | TODO | local API/PG/Redis/sync |
| 20 | Transactional Outbox | TODO | crash-safe sync |
| 21 | Offline Operation | TODO | 30-min offline Golden Path |
| 22 | Reconciliation | TODO | order/payment, wallet/ledger, service/commission, edge/cloud |
| 23 | Approval / Audit Hardening | TODO | high-risk approvals + audit completeness |
| 24 | Security Pass | TODO | independent red team, Blocker/High = 0 |
| 25 | UX Hardening | TODO | error/empty/loading/offline states, a11y |
| 26 | Backup / Restore | TODO | real restore drill (env-dependent) |
| 27 | Full E2E | TODO | automated Golden Path |
| 28 | Production Readiness Review | TODO | only if all gates pass |

## Working rules

1. Inspect current phase file before touching code; update `Current State` → `Verification Result`
   with exact commands + outcomes (paste tails, not vibes).
2. Finish a phase (verify → repair → record) before opening the next one.
3. `harness/build-log.md` gets one append per verification run (command, exit code, summary).
4. External unknowns → `BLOCKED` + `docs/adr` note or `EXTERNAL BLOCKER` marker in code/config;
   keep building non-blocked parts (Adapter pattern).
5. Spec ambiguity → the master spec wins; if it under-specifies a business rule, configure a dev
   default tagged `BUSINESS POLICY — REQUIRES PILOT VALIDATION` and log it under §21 of the spec.

## Open blockers / external dependencies (as of 2026-10-28)

- Docker daemon absent in build env → Compose stack authored, execution NOT VERIFIED.
- Android SDK/JDK absent → Phase 09/10 cannot be verified in this env.
- No real payment merchant credentials → FakeOnlinePaymentProvider + fail-closed production guard
  (Phase 12/13) tagged EXTERNAL BLOCKER.
- Real store SOP / wage samples absent → scheduling & commission weights are dev defaults,
  `BUSINESS POLICY — REQUIRES PILOT VALIDATION`.
