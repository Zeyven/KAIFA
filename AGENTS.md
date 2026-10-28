# AGENTS.md — LanXu StoreOS (澜序)

## What this repo is

LanXu StoreOS is an operating system for foot-bath/SPA/massage stores: rooms, technicians,
service sessions, orders, payments, members, devices — not a toy POS. The acceptance bar is
**ready for real store operation**. Source of truth: the frozen master spec at
`docs/product/lanxu-storeos-v1-master-spec.md` (Codex One-Shot Master Prompt V1.0).
Long-form knowledge lives in `docs/` (map below); phase state lives in `PLANS.md` +
`harness/phases/*.md`. Do NOT paste big specs into this file.

## Priority order (never trade away)

Correctness > Security/Authorization > Data/Financial Integrity > Reliability > Testability >
Maintainability > UX > Performance > Visual polish.

## Hard rules (permanent)

1. Never make CI green by deleting/skipping tests, loosening permissions, dropping constraints,
   swallowing exceptions, disabling typecheck, hardcoding success, or faking integration data.
2. All state changes go through domain commands/state machines. Clients may never
   `PATCH status` arbitrarily; guards are validated server-side inside one transaction.
3. Money is `bigint` cents (domain), `BIGINT` cents (DB), integer cents (JSON). Floats never
   represent RMB. Historical Payment/Refund/Wallet-ledger/Commission rows are append-only —
   fix errors with compensating records, never by rewriting history.
4. Every request is object-level authorized server-side: organization + store ownership and
   relations are re-derived from the authenticated principal. Client-supplied
   `storeId`/`roomId`/`userId` are untrusted hints only (OWASP API1/BOLA).
5. Payment success comes only from server-verified provider state (signed webhook / query), plus
   idempotency keys on dangerous writes. Cash is confirmed by the cashier session only.
6. Edge↔Cloud sync = transactional outbox/inbox + `eventId` dedupe. No last-write-wins for
   Payment / Wallet / ServiceSession / Scheduling / Commission / Refund.
7. Unknown real-world policies (scheduling weights, commission formulas, approval thresholds,
   payment merchant model) are configurable defaults tagged
   `BUSINESS POLICY — REQUIRES PILOT VALIDATION`. Never invent "the one true rule".
8. Every phase records Goal/Scope/Acceptance/Tests/Security/Migration/Rollback/DoD/Verification in
   `harness/phases/NN-*.md`. Run the applicable gates (format, lint, typecheck, unit,
   integration, migration, contract, build, security). Anything not executed is marked
   **NOT VERIFIED** — never claim DONE without evidence.
9. UUIDv7 everywhere (`lanxu_uuidv7()` in DB, `newUuidv7()` in app). timestamptz +
   explicit `business_date`. Integration tests run against REAL PostgreSQL (embedded PG 18 in
   this env) — no SQLite stand-ins for lock/transaction/index semantics.
10. Secrets never enter the repo, APK, logs, or audit rows; phones are stored hashed+encrypted
    and masked in logs.

## Architecture map

- `apps/api` — NestJS+Fastify modular monolith (Cloud API). Modules: Auth, Organization,
  Employee, Room, Catalog, Technician, Scheduling, Visit, ServiceSession, Order, Payment,
  Member/Wallet, Commission, Device, Approval, Audit, Reporting, EdgeSync.
- `apps/web` — Next.js FrontDesk/Manager/Boss/Staff.
- `apps/edge` — store-local营业 authority (Node + PG + Redis, offline Golden Path). PLANNED.
- `apps/room-android` — Kotlin/Compose kiosk (Dedicated Device/Lock Task). PLANNED.
- `packages/contracts` — zod schemas ↔ OpenAPI 3.1 (JSON Schema), error envelope, event types.
- `packages/domain` — pure domain: state machines, scheduling, money, uuidv7. No I/O.
- `packages/db` — migrations runner + SQL, pool helpers. Migrations are append-only checksummed.
- `packages/config` — zod-validated env/config loading.
- `packages/observability` — pino logging, request ids, redaction; OTel hooks later.
- `packages/testkit` — shared test utilities (embedded PG harness, factories).
- `packages/ui` — shared web primitives.
- `infra/docker` — dev compose (PG 18, Redis, api, web).
- `docs/` — see map below; `harness/` — phase records, reviews, build log.

Docs map: `product/product-brief.md`; `architecture/{system-architecture,domain-model,invariants,
state-machines,scheduling,offline-sync,api-contract,realtime-contract}.md`;
`security/{threat-model,authorization,device-security,payment-security}.md`;
`runbooks/{backup-restore,edge-outage,payment-outage,rollback}.md`; `adr/`.

## Build & verify (run from repo root)

```
npm ci                # install (npm workspaces)
npm run format:check  # prettier gate
npm run lint          # eslint gate
npm run typecheck     # tsc -b across packages + api, web typecheck
npm test              # unit tests (vitest)
npm run test:integration  # real PostgreSQL via embedded-postgres
npm run build         # tsc -b (packages, api) + next build
```

Phases must run every applicable gate above before claiming DoD. `npm run migrate -- up|status|down`
lives in `@lanxu/db` (see `docs/architecture/api-contract.md` + package README).

## Definition of Done (per phase)

implementation exists · tests added & pass · lint/typecheck/build pass · migration verified if
relevant · security reviewed · docs updated · no known Blocker. Otherwise mark
**IMPLEMENTED BUT NOT VERIFIED** or **BLOCKED** — not DONE.

## Review checklist (self-review before ending a phase)

Cross-store/cross-tenant IDOR on every new endpoint · guards inside the same transaction as the
state change · idempotency on money writes · append-only financial tables · error envelope with
`error.code` (clients key off codes, never English messages) · audit rows for high-risk actions ·
no floats in money paths · no secrets in logs.
