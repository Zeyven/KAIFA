# Phase 05 — Scheduling Algorithm + Queue Management (Batch B)

- **Goal**: deterministic §6 scheduling engine (hard constraints → weighted scoring → explainable recommend) with atomic assignment and queue operations.
- **Scope**: recommend (§6.5 shape {selected, excluded, weights}), atomic assign (§6.4 lock ordering + in-tx revalidation), skip (move to end), compensate (priority_delta, `schedule.assign.force`), reorder (numeric keys ≤50, active-only), queue listing with effective key order.
- **Files**: `packages/domain/src/scheduling.ts` (+tests); `apps/api/src/scheduling/{service,controller,module}.ts`; `apps/api/src/scheduling/scheduling.int.test.ts`; `app.module.ts` registration.
- **Acceptance**: 10 hard-constraint reasons returned machine-readable (no fabricated pick — selected omitted when nothing passes); weighted scoring with echoed `DEFAULT_SCHEDULING_WEIGHTS` + `BUSINESS POLICY` tag on every queue/recommend response; concurrent double-assign of one technician ⇒ exactly one 201 and one 422 (FOR UPDATE lock ordering + in-tx revalidation of status/queue/shift/skill); skill-missing assign → 422 TECHNICIAN_NOT_AVAILABLE; locked → 422 TECHNICIAN_LOCKED; queue ops reject non-ACTIVE entries; version staleness → 409; assign requires `schedule.assign`, compensate additionally `schedule.assign.force`.
- **Tests**: `scheduling.int.test.ts` **14 passed** including the concurrent race; `domain scheduling.test` 9 passed (scoring math, constraint reasons, recommend shape).
- **Security**: store-scoped candidates (single query, no cross-store leakage); permission split assign vs force (frontdesk denied force).
- **Migration**: none new (0003 tables reused).
- **Rollback**: redeploy previous tag (routes removal only — no schema).
- **Risk**: default weights/fairness/preference = dev defaults — BUSINESS POLICY — REQUIRES PILOT VALIDATION; reservation/overtime/preference facts currently constant until booking sources land; `service.assigned` event deferred to Phase 06.
- **DoD / Verification**: `npm run verify` EXIT 0 (unit 62 / integration 63×7 files / openapi / build).
