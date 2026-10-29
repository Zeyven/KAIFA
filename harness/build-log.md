# Build Log — verification evidence (append-only)

Convention: one entry per gate run — exact command, exit code, summary line. Claims without an
entry here are NOT VERIFIED.

---

## 2026-10-28 · Phase 00 Repository Foundation (full gate chain)

Environment: Node v22.22.3, npm 10.9.8, Linux x64, no Docker/apt egress (see
`harness/context/repository-baseline.md`).

| # | Command | Exit | Evidence / summary |
|---|---|---|---|
| 1 | `npm install` (clean: rm -rf node_modules + lockfile, after overrides fix) | 0 | 270 packages; single physical `fastify@5.12.7` (deduped with @nestjs/platform-fastify), `postcss@8.5.32` override applied, `vitest@5.0.5` |
| 2 | `npm run format:check` | 0 | "All matched files use Prettier code style!" |
| 3 | `npm run lint` | 0 | eslint 9 flat config, 0 errors, 0 warnings |
| 4 | `npm run typecheck` (`tsc -b` 8 projects + web `tsc --noEmit`) | 0 | no diagnostics |
| 5 | `npm test` (vitest 5, unit) | 0 | **7 files, 36/36 tests passed** (money, uuidv7, contracts/openapi, env fail-closed, redaction, ui, api health+pipe) |
| 6 | `npm run test:integration` (vitest 5, embedded PostgreSQL) | 0 | **1 file, 3/3 passed** — `SELECT version()` contains "PostgreSQL 18"; advisory-lock mutual exclusion proven (blocked vs granted); migrator fresh-DB status/up no-op |
| 7 | `npm run openapi` + `npm run openapi:check` | 0 | wrote `docs/architecture/openapi.json` (2 paths, ErrorEnvelope component) |
| 8 | `npm run build` (`tsc -b` + `next build`) | 0 | api/packages emitted; Next 15.5.28 static build, routes `/` + `/_not-found`, First Load JS 103 kB |
| 9 | `npm audit --audit-level=high` | 0 | **0 vulnerabilities** (after fixes: vitest 3→5 for tinypool RCE + mocker, fastify override 5.11.3→5.12.7 for validation-bypass advisories, postcss override →8.5.32) |
| 10 | live boot `node apps/api/dist/main.js` + curl | 0 | `GET /health/live` → 200 `{"data":{"status":"live"}}` + `x-request-id: smoke-001` echo; `GET /health/ready` (no DB) → 503 envelope `SERVICE_UNAVAILABLE` w/ UUIDv7 requestId; `GET /v1/nope` → 404 `NOT_FOUND` envelope. Server listening 0.0.0.0:4000 with structured pino logs |

### Root causes fixed during Phase 00 (never papered over)

1. `eslint.config.mjs` syntax typo (`eqeqeq'`) → corrected.
2. `parseUuidParts` regex: third/fourth UUID groups matched 2–3 chars instead of 4 → tests
   failed → regex fixed (real bug in parser, not test).
3. `parseCents` stripped commas before validating → `"1,2,3.45"` accepted as `123.45` →
   validate-before-strip fix.
4. Money float-demonstration test used a value < 2^53 (no precision loss possible) →
   corrected to a > 2^53 value (test was wrong, not the implementation).
5. Phone masking didn't normalize `+86` → masking showed `861****` → normalize country prefix.
6. `embedded-postgres` (ESM-only, exports-map) invisible to classic `moduleResolution` and
   static type import raised TS1541 → testkit on `moduleResolution: node16` + dynamic import
   with inferred type.
7. Duplicate `fastify` copies (root ^5.0.0→5.12.7 vs Nest's pinned 5.11.3) broke adapter
   option types → pinned, later overridden to 5.12.7 for security fixes; `npm dedupe` +
   clean re-resolve verified with `npm ls`.
8. Fresh-DB `migrator.status()` errored on missing `schema_migrations` (42P01) → treated as
   "no applied migrations" (fail-closed elsewhere: unknown DB errors still throw).
9. Fastify `disableRequestLogging` deprecated (FSTDEP023) → option dropped (logger already
   off; access logs owned by our onResponse hook).
10. Security advisories (2 critical / 2 high / 3 moderate) → fixed via vitest 5 upgrade and
    dependency overrides; re-audit = 0.

### NOT VERIFIED in this environment

- Docker compose / Dockerfiles (no daemon) — file-complete only.
- GitHub Actions execution (workflow authored; validated only by local equivalent commands).
- Android toolchain (no JDK/SDK).

---

## 2026-10-28 · Phase 01 Database Foundation (full gate chain)

| # | Command | Exit | Evidence / summary |
|---|---|---|---|
| 11 | `npm run verify` (format → lint → typecheck → unit → integration → openapi → build) | 0 | all green in one chain |
| 12 | `npm test` | 0 | 7 files, 36/36 unit tests |
| 13 | `npm run test:integration` | 0 | **3 files, 14/14** on embedded PostgreSQL 18: migrations suite (9) + readiness e2e (2) + harness smoke (3) |
| 14 | `npm audit --audit-level=high` | 0 | still 0 vulnerabilities |

Migration gate highlights (each a test, real PG18): fresh up records sha256 checksum ·
re-up idempotent · **down(1) + two concurrent up() ⇒ exactly once** (advisory lock) ·
tampered applied file rejected (MigrationError) · CLI `dist/cli.js status` spawn ✓ ·
constraint matrix 23505/23503/23514 ✓ · UUIDv7 defaults (org/store/user + 50 bulk) ✓ ·
RBAC seed spot-checks vs spec §11 ✓ · `/health/ready` 503 pending → 200 after migrate ✓.

### Root causes fixed during Phase 01 (evidence, no papering)

11. Seed SQL: doubled `CASE` introduced by an edit → `= ANY ((CASE…` paren/type error →
    de-duplicated; `IN (array)` replaced with `= ANY((…)::text[])`.
12. `lanxu_uuidv7()`: `bytea::uuid` cast does not exist → hex text formatted with hyphens.
13. `lanxu_uuidv7()`: variant built as `2^62 + rand` yields variant bits `01` (and `2^63`
    would overflow bigint) → variant nibble assembled as hex `8..b`; test caught it via
    `isUuidV7` (would have shipped invalid UUIDs — real catch).
14. Test CTE selected non-existent `organization_id` from RETURNING id-only CTE → fixed to
    `SELECT id`; dependent tests then passed (cascade root cause was this one query).
15. Post-`down` assertion wrongly expected zero pending files → pending must equal files on
    disk; assertion corrected (behavior was right, expectation wrong).
16. `to_regclass('public.x')` returns unqualified name when schema is in search_path →
    assertion accepts both forms.
17. Package-name **self-import** inside `packages/db` resolved to its own `dist` outputs →
    TS5055; switched to relative import (rule recorded in test header + phase file).
18. Query row-type generic mismatched selected columns (`id` vs `org_id/store_id/user_id`)
    → typed accurately.
19. Phase 00 smoke asserted "no migrations yet" — stale after Phase 01 landed SQL → updated
    to dynamic mirror of the migrations directory (pending ⇔ files, isCurrent false).

---

## 2026-10-29 · Phases 02 Authentication + 03 Room Domain (full gate chain)

Batch A (02+03) implemented together: one global auth pipeline + room commands on top of
migration 0002 (rooms/visits/audit/outbox). Local branch history note: this working tree
was reconciled with `origin/arena/d40c861f-kaifa` (`c98ed06`, Phase 01) via mixed reset
before this phase's commit — Phase 00/01 files byte-identical (status showed only 02/03
paths), remote history preserved.

| # | Command | Exit | Evidence / summary |
|---|---|---|---|
| 20 | `npm run verify` (format → lint → typecheck → unit → integration → openapi → build) | 0 | all green in one chain |
| 21 | `npm test` | 0 | **9 files, 47/47 unit** (adds domain password (5) + room-state machine (6); health suite back to green) |
| 22 | `npm run test:integration` | 0 | **5 files, 36/36 on embedded PostgreSQL 18**: migrations (9, now 2-migration chain: down(2)+concurrent exactly-once) + readiness (2) + harness (3) + **auth (10)** + **rooms (12)** |
| 23 | `npm audit --audit-level=high` | 0 | 0 vulnerabilities (jose@6.2.13 added) |
| 24 | `npm run openapi:check` | 0 | regenerated `docs/architecture/openapi.json` (2 paths, no drift) |
| 25 | `npm run test:integration` ×3 after pool-error hardening | 0,0,0 | **36/36 each run** — teardown FATAL(57P01) on idle socket now logged via pool `error` listener (pg contract), no uncaught exceptions |

Auth integration highlights (real HTTP → real PG): login store list · wrong-password ≡
unknown-user (same code+message) · missing/tampered/**forged-expired** JWT (same secret,
exp actually enforced) · missing & foreign `X-Store-Id` → 403 UNAUTHORIZED_SCOPE ·
IDOR: store-B clerk reading store-A room → 404 (no existence leak), claiming store A →
403 · FORBIDDEN names the missing code · 5 fails/60s → 429 even with valid password after
· `security_events` evidence (LOGIN_FAILED/SUCCESS + AUTHZ_DENIED) · `/v1/auth/me`
bootstrap ± store context.

Room integration highlights: open → OCCUPIED + visit row + audit row + `store_seq=1`
outbox + `stores.last_event_seq=1` · double-open → 422 ROOM_OCCUPIED unchanged · stale
`expectedVersion` → 409 with **no partial write** (no audit row) · move → source DIRTY /
target OCCUPIED / visit.room_id moved / `visit.moved`+2×`room.updated` · checklist guard
(422 ROOM_NOT_ELIGIBLE) blocks cleaning-complete · maintenance chain END→VACANT_CLEAN
(spec §5.1) · disable/enable flips `status` column · `PATCH /v1/rooms/:id` → 404
(command-endpoint-only, I5) · DB triggers reject direct UPDATE/DELETE on
audit_logs/security_events/outbox with SQLSTATE **23001 restrict_violation** ·
cross-store fetch → 404.

### Root causes fixed during Phases 02/03 (never papered over)

20. `login` query selected `u.organization_id` but code read `user.org_id` → `undefined`
    claim → empty store list + NULL-org security rows + **every protected route 401**
    (one column-alias bug, three symptoms; caught by integration test, not guessed).
21. `jose.setExpirationTime(3600)` treats numbers as **absolute unix seconds** → tokens
    born expired → 401 everywhere despite valid signature → explicit `iat=now`,
    `exp=now+ttl` (and dropped a non-existent `jose.importKey` API — HS256 takes the raw
    UTF-8 secret as Uint8Array).
22. 0002 RBAC grants used one exclusive `CASE` — each role landed in at most ONE branch,
    so boss/supervisor silently never received `room.maintenance`/`room.disable` (403 on
    legitimate commands) → one INSERT per capability with `ON CONFLICT DO NOTHING`.
23. `bumpRoom` used `current_visit_id = COALESCE($3, old)` → clearing on **move** source
    was impossible (null = keep) → explicit set/clear/keep op; move test's
    `current_visit_id IS NULL` assertion caught it.
24. `DatabaseModule` factory injected `ENV` without importing `EnvModule` → DI failure at
    app boot (health unit suite failed instantly) → module import added.
25. `AppAuthGuard`/services used bare constructor types → invisible under esbuild
    (no `emitDecoratorMetadata`) would break tests-only → explicit `@Inject(Class)`
    convention everywhere; `'APP_GUARD'` string replaced with `@nestjs/core`'s token.
26. Health routes predated the guard → probes would demand JWT → `@Public()` on
    `/health/live` + `/health/ready` (orchestrators/LB must reach them).
27. Maintenance edges inconsistent (RESERVED/DIRTY allowed but missing from test's LEGAL
    list; occupied rejection had table entry for OCCUPIED but not IN_SERVICE/WAITING_CHECKOUT)
    → spec §5.1 "non-occupied" implemented uniformly for all four non-occupied states,
    guard-rejected (ROOM_NOT_ELIGIBLE) for the occupied family; tests assert exact codes.
28. jose dynamic import under vitest surfaced named exports differently across runs →
    irrelevant once `importKey` myth removed; loader now uses jose's own types
    (`import type * as Jose`) — no hand-rolled casts.
29. Test expected append-only trigger SQLSTATE `55000`; actual (correct) code for
    `restrict_violation` is **`23001`** — verified empirically against real PG before
    changing the expectation (migration was right, expectation wrong).
30. Stale Phase-01 assertions after 0002 landed (migrations suite assumed a single
    migration; ready test hard-coded `['0001…']`) → generalized to the full chain
    (applied = both files, down(2), checksum per file, CLI `applied (2)`).
31. Test expectations vs spec: `MAINTENANCE_END → VACANT_CLEAN` (spec table) and
    checklist-failure → `ROOM_NOT_ELIGIBLE` (guard code, edge exists) — machine matched
    spec, expectations corrected (not the machine).
32. Integration run exited 1 with an **uncaught** pg `57P01 terminating connection due to
    administrator command` from an idle pooled socket during harness teardown (all 36
    tests had passed) → root fix in `createPool`: pool-level `error` listener as pg
    documents for idle-client async errors; in-flight query losses still reject their
    queries (loudly). Verified stable: 3 consecutive integration runs exit 0.

### NOT VERIFIED in this environment (unchanged)

- Docker compose / Dockerfiles (no daemon), GitHub Actions run (workflow authored),
  Android toolchain, restore drill (Phase 01 note).
