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
