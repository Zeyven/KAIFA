# Phase 03 — Room Domain

## Goal

Room/area/bed schema + spec §5.1 operational state machine enforced through explicit
command endpoints with in-transaction guard revalidation, audit evidence, and
transactional-outbox `storeSeq` events (spec §5.1, §7.3, §8, §12.2; invariants I6/I21–I25).

## Current State

Complete. Full verify chain exit 0 on 2026-10-29 (evidence: `harness/build-log.md`).

## Scope

- Migration `0002_rooms_visits_audit_events.{up,down}.sql`:
  - `areas`, `rooms` (UNIQUE(store,code), operational_state CHECK per §5.1 set,
    `version > 0` optimistic lock, `current_visit_id` FK), `beds`, `visits`
    (guest_count/business_date/status CHECKs).
  - `audit_logs` + `security_events` append-only via BEFORE UPDATE/DELETE triggers
    (`forbid_mutation()` → SQLSTATE **23001 restrict_violation**, invariant I25).
  - `outbox_events` (per-store `store_seq` BIGINT, `UNIQUE(store_id, store_seq)`,
    immutability trigger — only `published_at` may change) + `stores.last_event_seq`.
  - RBAC extension: `room.read` (all 8 system roles) + `room.clean` /
    `room.maintenance` / `room.disable` grants — **BUSINESS POLICY — REQUIRES PILOT
    VALIDATION** (conservative placement: clean: frontdesk/cashier/supervisor/manager/
    boss; maintenance: supervisor+; disable: manager/boss).
- `packages/domain/src/room-state.ts`: full §5.1 matrix as data + guards
  (hasActiveVisit/hasActiveSession/hasRunningSession/balanceSettled/cleanerAuthorized/
  checklistPassed/inspectionPassed), machine-readable failure codes
  (INVALID_STATE_TRANSITION / ROOM_NOT_ELIGIBLE / ROOM_OCCUPIED); spec-gap edges
  `VISIT_MOVED` (OCCUPIED→DIRTY, RESERVED→VACANT_CLEAN) documented as BUSINESS POLICY.
- `appendStoreEvent(client, …)` (`common/store-events.ts`): in the command's own
  transaction, `UPDATE stores SET last_event_seq = last_event_seq+1 … RETURNING` +
  outbox insert — a committed state change can never exist without its event (I21/I22).
- Rooms commands (`rooms.service.ts` / `rooms.controller.ts`), every one: open tx →
  `SELECT … FOR UPDATE` (move locks both rooms in sorted-id order) → machine +
  guards revalidated in-tx → optimistic `expectedVersion` → 409 VERSION_CONFLICT →
  audit row (`AuditService.record` same client) → outbox event(s) → commit.
  - `GET /v1/rooms`, `GET /v1/rooms/:roomId` (store-scoped, 404 across stores)
  - `POST :roomId/open` (inserts visit, computes business_date from store
    timezone/cutoff in SQL), `:roomId/move` (visit row + vacated→DIRTY + 3 events),
    `:roomId/cleaning-start|cleaning-complete(checklistPassed)`,
    `:roomId/maintenance-start|maintenance-end(inspectionPassed)`,
    `:roomId/disable|enable`.
  - No generic status PATCH exists anywhere (tested: PATCH → 404).

## Non-goals

Reservation creation flow (RESERVED is seeded/reached by scheduling — Phase 05),
service-session/order edges of the machine (06/12 — machine already models them),
FrontDesk UI (07), real-time push of storeSeq (WebSocket phase 17).

## Files

`packages/db/migrations/0002_rooms_visits_audit_events.{up,down}.sql` ·
`packages/domain/src/room-state.ts` + `room-state.test.ts` ·
`packages/contracts/src/events.ts` (+`visit.moved`) ·
`packages/testkit/src/tenant.ts` (+`@lanxu/domain` dep) ·
`apps/api/src/rooms/{rooms.module,rooms.controller,rooms.service}.ts` ·
`apps/api/src/common/store-events.ts`, `audit/audit.service.ts` ·
`apps/api/src/rooms/rooms.int.test.ts` · `packages/db/src/migrations.int.test.ts`
(extended to 2-migration chain).

## Architecture Decisions

- State machine is pure domain code (`canTransition`), but every API command re-runs it
  **inside** the locking transaction — no stale reads, no client-trusted state.
- `move` emits `visit.moved` + two `room.updated` events (registry extended per §16.4
  rule: new event = registry entry); boards key off `room.updated`.
- `current_visit_id` updates use an explicit set/clear/keep op (a COALESCE(null, old)
  pattern cannot clear — caught by the move test).
- `room.read` added as an explicit permission (all roles) so reads also pass through the
  same guard pipeline instead of a special case.
- Fixture-seeded states (e.g. DIRTY room) are allowed as test preconditions, but every
  state *change* flows through commands — DB triggers + endpoints enforce it.

## Acceptance Criteria

1. `npm run verify` → 0 — ✅
2. 0002 gates on real PG18: fresh up (checksum), idempotent re-up, down(2) full revert +
   concurrent up exactly-once, checksum tamper — ✅ (migrations suite, now 2-migration aware)
3. open → OCCUPIED_WAITING_SERVICE + visit row + audit + storeSeq=1 outbox + stores
   last_event_seq — ✅
4. double-open → 422 ROOM_OCCUPIED with state unchanged — ✅
5. move: source DIRTY, target OCCUPIED, visit.room_id relocated, 3 events — ✅
6. cleaning chain w/ checklist guard; maintenance chain (END→VACANT_CLEAN per §5.1);
   disable/enable flips status column — ✅
7. expectedVersion stale → 409 with no partial write (no audit row) — ✅
8. Append-only DB triggers: direct UPDATE/DELETE on audit_logs/security_events/outbox
   rejected (23001) at the database layer, not just app code — ✅
9. No generic status PATCH — ✅

## Tests

Unit `room-state.test.ts` (6): every legal edge incl. gap-fills, full illegal
cross-product (exact machine codes), shortcut prohibitions, guard matrix, maintenance
non-occupied rule, machine-readable codes.
Integration `rooms.int.test.ts` (12) on real PG18 via HTTP: list/open/double-open/
optimistic-lock/move+moved events/rejections/cleaning checklist guard/maintenance/
disable-enable/PATCH-404/trigger denials/cross-store 404. Migrations suite extended to
the full 0001+0002 chain (down(2), checksums, concurrent exactly-once). testkit
`seedTenant` factory seeds org+2 stores+users+employees+role grants+rooms with real
scrypt hashes and real RBAC rows (no auth bypass).

## Security Considerations

- Object-level: every query is `WHERE id=$1 AND store_id=$authStoreId` — cross-store ids
  are indistinguishable from missing (404), scope checked before object lookup.
- Permissions per command: room.read/open/move/clean/maintenance/disable (ALL-of).
- Audit rows carry actor employee id, request id, IP, before/after (redacted through
  `redactForLog`); append-only at DB level (I25) — tampering requires superuser DDL.
- Outbox payload contains business fields only — no tokens/PII.

## Migration Considerations

- 0002 reversible (drops objects + deletes the 4 added permission codes) — dev/empty DBs
  only; live = snapshot (runbook). Insert-order safe: permissions before grants.
- RBAC extension is append-only (never edits 0001 rows).

## Rollback

`npm run migrate down 1` (dev) reverts 0002 including permission rows; production =
snapshot restore (docs/runbooks/rollback.md).

## Risks

- Room-command permission placement (clean/maintenance/disable) is a conservative
  default — BUSINESS POLICY — REQUIRES PILOT VALIDATION (marked in migration + this file).
- `VISIT_MOVED` edges are spec-gap fills — confirm at pilot that vacated rooms must be
  DIRTY (vs auto-cleaning) — BUSINESS POLICY marked.
- business_date cutoff uses store timezone + `business_date_cutoff_time` — DST zones are
  China-only in V1 (CNY/Asia/Shanghai), revisit if multi-tz pilots happen.

## Definition of Done

implementation ✅ · tests ✅ · lint ✅ · typecheck ✅ · build ✅ · migration verified ✅ ·
security reviewed ✅ · docs updated ✅ · no known Blocker ✅

## Verification Result

**DONE** — `npm run verify` exit 0 (2026-10-29), details in `harness/build-log.md`
(Phase 02/03 section).
