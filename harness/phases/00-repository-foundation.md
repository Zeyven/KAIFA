# Phase 00 — Repository Foundation

Template per Master Prompt §19.1. Status vocabulary per `PLANS.md`.

## Goal

Monorepo + toolchain + CI + Docker dev files + AGENTS/PLANS/docs skeleton + first batch of
tests, verified by install/lint/typecheck/test/build (spec §19 Phase 00).

## Current State

Complete. All gates executed with evidence in `harness/build-log.md` (2026-10-28).

## Scope

- Inspect record: `harness/context/repository-baseline.md`.
- Governance: `AGENTS.md` (lean), `PLANS.md`, `README.md`, `SECURITY.md`.
- Knowledge base: product brief, master spec copy, 9 architecture docs, 4 security docs,
  4 runbooks, ADR 0001–0005.
- Workspace: npm workspaces — `apps/api` (NestJS 11 + Fastify 5), `apps/web` (Next 15.5),
  `packages/{contracts,domain,config,db,observability,testkit,ui}`.
- Primitives with tests: money (bigint cents), uuidv7 (app + later DB fn), error envelope +
  code registry, zod→OpenAPI 3.1 generator, env fail-closed validation, log redaction,
  health/live + health/ready, ZodValidationPipe, error filter, request-id pipeline.
- DB: checksummed migration runner (up/status/down/verify + advisory lock) — no business SQL
  yet (Phase 01).
- Test harness: embedded real PostgreSQL 18 (ADR-0003) + smoke integration suite.
- CI: `.github/workflows/ci.yml` (format, lint, typecheck, unit, integration, contract,
  build, audit, float-money grep).
- Infra files: `infra/docker/*` (Dockerfiles + compose), `.env.example`.

## Non-goals (deferred)

Auth (02), room domain (03), migrations content (01), WS (18), Edge (19), Android (09/10),
Docker execution, GitHub-hosted CI execution.

## Files

Root: `package.json`, `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc.json`,
`.prettierignore`, `.gitignore`, `.env.example`, `vitest.config.ts`,
`vitest.integration.config.ts`, `scripts/generate-openapi.ts`.
Apps/packages per architecture map in `AGENTS.md`. Docs per §3.2 list.

## Architecture Decisions

ADR-0001 modular monolith · ADR-0002 money bigint-cents · ADR-0003 embedded real PG for
tests · ADR-0004 UUIDv7 (app generator + DB function, DB fn lands in 0001 migration) ·
ADR-0005 zod single-source contracts.

Cross-cutting convention: **Nest constructor DI uses explicit `@Inject(TOKEN)`** (module
string tokens) so runtime behavior is identical under tsc (decorator metadata) and
vitest/esbuild (no metadata) — no test/prod divergence.

## Acceptance Criteria

1. `npm ci && npm run format:check && npm run lint && npm run typecheck && npm test &&
   npm run test:integration && npm run openapi:check && npm run build` → all exit 0. ✅
2. `npm audit --audit-level=high` → 0. ✅
3. API boots and serves `/health/live` + honest `/health/ready` with frozen error envelope
   and UUIDv7 request ids. ✅ (live curl evidence)
4. Integration suite runs against REAL PostgreSQL 18, not an emulator. ✅
5. CI workflow exists covering the same gates + security checks. ✅ (execution on
   GitHub = NOT VERIFIED until first PR run)
6. Docker dev stack authored. ✅ file-complete; execution NOT VERIFIED (no daemon).

## Tests

Unit 36: money 8 · uuidv7 5 · contracts/openapi 5 · env fail-closed 6 · redaction 4 ·
ui 2 · api health + zod pipe 6.
Integration 3: PG18 version assertion, advisory-lock mutual exclusion, migrator fresh state.

## Security Considerations

- Fail-closed env guards (dev JWT secret / fake provider refused in production) tested.
- Redaction unit-tested (invariant I26); no secrets in repo (`.gitignore`, `.env.example`).
- Audit gate green after dependency remediation (vitest/fastify/postcss advisories fixed).
- Request-id header sanitized (printable ASCII ≤128) against log injection.

## Migration Considerations

Runner implemented + tested for empty history only; `.down.sql` convention, checksum
tamper detection, advisory-lock serialization in place. Real schema arrives Phase 01 with
fresh/up/down gates.

## Rollback

Phase 00 has no data; revert commit(s). Migrations dir empty → no down risk.

## Risks

1. ESLint 9 line deprecated upstream (npm warn) → plan eslint 10 + typescript-eslint
   compatibility check in a hardening pass.
2. Next's ESLint plugin not wired (build warning) → Phase 07 when web code grows.
3. `openapi:check` diff gate only becomes meaningful once `openapi.json` is committed (it is,
   in this phase's commit) and on CI runners.
4. vitest 5 is a major jump made for security advisories — behavior covered by full suite
   green; watch for API drift in later phases.

## Definition of Done

implementation exists ✅ · tests added & pass ✅ · lint ✅ · typecheck ✅ · build ✅ ·
migration verified (N/A for content; runner smoke only) ⚠️ · security reviewed ✅ (audit 0,
threat docs indexed) · docs updated ✅ · no known Blocker ✅

## Verification Result

**DONE** — full gate chain executed 2026-10-28, evidence table in
`harness/build-log.md` (#1–#10). Items not executable in this environment are explicitly
NOT VERIFIED there (Docker, GitHub-hosted CI, Android).
