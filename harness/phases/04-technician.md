# Phase 04 — Technician Command Surface (Batch B)

- **Goal**: expose the §5.2 technician state machine over authenticated HTTP with queue lifecycle side effects and object-level authorization.
- **Scope**: clock-in/out, lock/unlock, break start/end; identity-gated commands (own row or `tech.manage`); status history + queue entry management; store events + audit.
- **Files**: `migrations/0003_technician_queue.{up,down}.sql`; `packages/domain/src/technician-state.ts` (+tests); `apps/api/src/technicians/{service,controller,module}.ts`; `apps/api/src/technicians/technicians.int.test.ts`; `packages/testkit/src/tenant.ts` (technician fixtures); `app.module.ts` registration; permission codes `tech.read`/`tech.manage`.
- **Acceptance**: list scoped by X-Store-Id (tech.read); commands transition 8-state machine with 422 on invalid; clock-in requires ACTIVE shift (403) and creates queue entry ENQUEUED (position MAX+1000) + history + `technician.status_changed`/`technician.queue_changed` events + audit; clock-out removes entry (DEQUEUED); self-employee allowed without `tech.manage`, other employees require it; cross-store 404; stale expectedVersion 409; `technician_status_history` append-only (23001).
- **Tests**: `technicians.int.test.ts` **13 passed** (real HTTP + real PG18).
- **Security**: permission split `tech.read` (all roles) vs `tech.manage` (supervisor/manager/boss — BUSINESS POLICY); in-transaction identity check; object-level store scoping.
- **Migration**: 0003 up (catalog subset + technicians + skills + history + queue_events + shifts + queue_entries) / down; reversible in migrations.int (9/9 with 0003 present).
- **Rollback**: `npm run db:down -- 0003_technician_queue` then redeploy previous tag; 0001/0002 untouched.
- **Risk**: queue position policy (MAX+1000) is a dev default — BUSINESS POLICY — REQUIRES PILOT VALIDATION.
- **DoD / Verification**: `npm run verify` EXIT 0 after phase (format/lint/typecheck/unit 62/integration 63×7/openapi/build).
