# Phase 08 — Clock Board (排钟大屏, spec §9.3)

- **Goal**: frontdesk scheduling vertical — explainable recommend + queue management + 派单开服务, on live API.
- **Scope**: additive reads `GET /v1/service-sessions` (store-scoped; today = visit business_date) and `GET /v1/service-variants` (org catalog under service.read); `/frontdesk/clock` page (technician table 号码/状态/排位/今日/点钟/空闲 + queue-state column; recommend card with selected/excluded-reasons/echoed-weights/policy tag per §6.5; skip/compensate/clock-in actions with verbatim server errors; dispatch flow: recommend → occupied room select → POST /service-sessions); nav link 钟房.
- **Files**: `apps/api/src/sessions/sessions.{service,controller}.ts` (list), `apps/api/src/catalog/*`, `apps/web/src/lib/clock-board.{ts,test.ts}`, `apps/web/src/app/frontdesk/clock/page.tsx`, layout nav, globals.css, `web-proxy.int.test.ts` (+1 case), sessions.int.test (+1).
- **Acceptance**: every figure traces to a live GET (no fabricated KPIs — documented in model header); recommend renders policy tag + hard-constraint reasons verbatim; list filters + cross-store scoping proven; proxy E2E covers variants/queue/recommend/today.
- **Tests**: sessions.int 13/13; web unit 11/11; proxy e2e 6/6; `npm run verify` EXIT 0 (unit 85, integration 82×9).
- **Security**: sessions list gated by service.read + store header scoping; variants org-scoped under service.read; dispatch runs full server-side gates (skill/status/partial-unique) — UI never bypasses.
- **Migration**: none (0004 reused).
- **Rollback**: revert web + remove two additive GET routes (no schema).
- **Risk**: 点钟 definition = REQUESTED assignment_type (no separate request table yet) — BUSINESS POLICY — REQUIRES PILOT VALIDATION; skipped `service_request.created` contract event (table lands Phase 09+).
- **DoD / Verification**: `npm run verify` EXIT 0; evidence build-log #42–#45 + root causes #50/#51.
