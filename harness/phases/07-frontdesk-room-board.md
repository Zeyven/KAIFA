# Phase 07 — FrontDesk Room Board (vertical slice)

- **Goal**: first real web UI on the live API — login → 房态大屏 (§9.2) → room commands, through the Next proxy (browser never addresses the API host).
- **Scope**: `next.config.mjs` rewrite `/api/v1/* → API`; API client with frozen-envelope unwrap + SessionStorage; `/login`; FrontDesk shell (session guard, store switcher via X-Store-Id, clock); `/frontdesk/rooms` board (KPI strip: 客流/空房/空闲技师/待服务 all live-derived, 营业额 honest null until Phase 08; room cards with MANDATORY text labels + tone colors; open/clean/clean-complete commands); `/frontdesk/rooms/:id` detail (full command surface + move with expectedVersion, verbatim 403/409/422 errors).
- **Files**: `apps/web/next.config.mjs`, `apps/web/src/lib/api.{ts,test.ts}`, `apps/web/src/app/login/page.tsx`, `src/app/frontdesk/{layout.tsx,rooms/page.tsx,rooms/[roomId]/page.tsx}`, `globals.css`, `apps/web/src/web-proxy.int.test.ts`, home phase list.
- **Acceptance**: labels cover all 9 room + 8 tech states (§9.2 text-not-color rule); KPI figures trace to GET endpoints only; commands send expectedVersion; store switcher only changes the header (server re-authorizes); SSR login page 200; proxy E2E proves read+write+error envelope end-to-end.
- **Tests**: web unit **8/8**; `web-proxy.int.test.ts` **5/5** (PG+API+Next spawned); full `npm run verify` EXIT 0 (unit 82, integration 80×9).
- **Security**: token + X-Store-Id only in localStorage; no API host in browser; all authoritative checks stay server-side (E2E asserts 401 envelope via proxy).
- **Migration**: none.
- **Rollback**: web-only rollback by git revert (no schema coupling).
- **Risk**: browser-driven Playwright E2E not run (browser binary download outside allowed egress) — covered instead by browserless proxy E2E; component-level jsdom tests deferred to Phase 25 UX hardening.
- **DoD / Verification**: `npm run verify` EXIT 0; evidence build-log #36–#38 + root causes #45–#47.
