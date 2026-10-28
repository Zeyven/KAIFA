# Phase 01 — Database Foundation

## Goal

Real PostgreSQL + migration tooling + `organizations/stores/identity/RBAC` schema with
`migrate fresh/up/down` gates (spec §19 Phase 01).

## Current State

Complete. Full verify chain exit 0 on 2026-10-28 (evidence: `harness/build-log.md`).

## Scope

- `packages/db/migrations/0001_foundation_identity.up.sql` (+ `.down.sql`):
  - `lanxu_uuidv7()` DB default for every business PK (ADR-0004, invariant I1).
  - organizations, stores (UNIQUE(org,code), CNY/CHECK), store_settings (JSONB object
    CHECKs, no secrets), users (UNIQUE(org,username), partial unique phone_hash),
    employees (UNIQUE(store,employee_no), LEFT⇒left_at≥joined_at CHECKs),
    roles (system-role partial uniques + org/system CHECK), permissions, employee_roles,
    role_permissions (composite PKs per spec §4.3).
  - RBAC seed: 15 permission codes + 8 system roles + role_permissions exactly per the
    spec §11 matrix (△ thresholds remain config, not permissions).
- Gates exercised: fresh up (checksum recorded) · idempotent re-up · **down(1) → concurrent
  up applied exactly once** (advisory-lock serialization on real work) · checksum tamper
  detection (tampered copy rejected) · CLI `dist/cli.js status` spawn · constraint matrix
  (23505/23503/23514 for unique/FK/CHECK) · UUIDv7 defaults for org/store/user + 50 bulk
  inserts · RBAC spot-checks (frontdesk≠refund.approve, cashier≠schedule.assign,
  technician only self-service, finance≠room.open, manager rbac.manage, boss all).
- API readiness end-to-end: `/health/ready` = 503 `migrations pending` → migrate up →
  200 `{db:ok, migrations:ok}` on real PG18 (`apps/api/src/health/ready.int.test.ts`).
- Phase 00 smoke updated to mirror the now-present migration files (pending ⇔ files on
  disk, `isCurrent=false` when pending — fail closed).

## Non-goals

areas/rooms/beds (Phase 03), technicians/queue (04/05), sessions/orders/payment/wallet
(06+), RLS policies (later hardening — service-level authz exists first per spec §4.9),
seed data beyond RBAC.

## Files

`packages/db/migrations/0001_foundation_identity.{up,down}.sql` ·
`packages/db/src/migrations.int.test.ts` · `packages/testkit/src/postgres.int.test.ts`
(updated) · `apps/api/src/health/ready.int.test.ts` · `packages/db/migrations/README.md`.

## Architecture Decisions

- Applied-migration history is append-only + checksummed; editing an applied `.up.sql` is a
  hard error (tested via tampered copy).
- System roles modeled with org NULL + partial unique indexes (plain UNIQUE ignores NULLs).
- `lanxu_uuidv7()` as column DEFAULT keeps every insert path compliant (seeds included);
  variant/`rand_b` assembled from hex digits because signed-bigint 2^63 overflows.
- Self-import inside a package is banned (resolves to own dist ⇒ TS5055) — relative
  imports in-package; recorded in test header.

## Acceptance Criteria

1. `npm run verify` → 0 (format, lint, typecheck, unit 36, integration 14, openapi, build).
2. Migration fresh/up/down + checksum gates pass on real PG18 — ✅
3. Schema matches spec §4.1/§4.2/§4.3 conventions (uuidv7, timestamptz, BIGINT-ready,
   version columns where mandated) — ✅ (version columns arrive with their aggregates)
4. RBAC seed == spec §11 matrix — ✅ (spot-check suite)
5. Readiness honestly reflects migration state — ✅ (503→200 test)

## Tests

Integration 14 total in run: migrations suite (9) + readiness (2) + Phase 00 harness (3),
all against embedded PostgreSQL 18.

## Security Considerations

- FK RESTRICT on org/store parents (no silent tenant deletion); phone_hash partial unique
  for per-tenant lookup; password_hash length unconstrained at DB (scrypt format enforced
  Phase 02); no secrets columns in store_settings (comment + review).
- Fail-closed readiness when schema/migrations invalid (incl. checksum tamper).

## Migration Considerations

- 0001 reversible (drops objects) — intended for dev/empty DBs only; live rollback =
  snapshot (header + runbook). Lock risk LOW (empty tables only).
- Runner serializes via advisory lock; each migration in one transaction; parallel up
  applies exactly once (tested).

## Rollback

`npm run migrate down 1` on dev; production = snapshot restore (docs/runbooks/rollback.md).

## Risks

- `current_date` in employees.joined_at depends on DB timezone — store timezone policy
  lands with employee ops (mark: BUSINESS POLICY check at pilot).
- RBAC matrix permissions for later phases (wallet/commission/etc.) seeded early — codes
  may be extended by append-only migrations, never edited.

## Definition of Done

implementation ✅ · tests ✅ · lint ✅ · typecheck ✅ · build ✅ · migration verified ✅ ·
security reviewed ✅ · docs updated ✅ · no known Blocker ✅

## Verification Result

**DONE** — `npm run verify` exit 0 (2026-10-28), details in `harness/build-log.md`
(Phase 01 section). Android/Docker/CI-host items remain NOT VERIFIED per Phase 00 note.
