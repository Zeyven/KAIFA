# Repository Baseline (Inspect Record)

- Date: 2026-10-28 (UTC)
- Branch: `arena/d40c861f-kaifa` (from `KAIFA@a087d9c`)
- Inspected by: Codex/Agent — Phase 00 pre-work, per Master Prompt §1.2 "先 Inspect".

## 1. Repository state at inspection

| Item | Finding |
|---|---|
| Files | `LICENSE` only (Apache License 2.0) |
| Git history | single commit `a087d9c Initial commit` |
| Source / tests / schema / migrations | none |
| CI / docs / AGENTS.md / PLANS.md | none |
| Remote | `origin/KAIFA` (default), work happens on `arena/d40c861f-kaifa` |

**Conclusion: the repository is EMPTY.** Per Master Prompt, we bootstrap the monorepo, toolchain, CI,
dev environment, documentation and the first batch of tests from the frozen spec. There is no
existing code to preserve or inspect beyond the license.

## 2. Environment capability inventory

| Capability | Status | Consequence |
|---|---|---|
| Node.js | v22.22.3 | Base runtime for apps/api/edge |
| npm | 10.9.8 | Monorepo via npm workspaces (no extra package-manager bootstrap risk) |
| pnpm / yarn | not used | npm workspaces chosen for zero-bootstrap reliability |
| Docker | **absent** | `infra/docker/*` files authored but Docker Compose dev stack NOT VERIFIED locally |
| PostgreSQL (system) | **absent**; apt egress blocked | Integration tests must use `embedded-postgres` (real PostgreSQL 18.4 binaries shipped via npm) |
| Redis (system) | **absent** | Redis-dependent paths deferred; local fallbacks must be explicit and flagged |
| Python | 3.11.2 | helper scripts only |
| Java / Android SDK | **absent** | `apps/room-android` stays PLANNED; Android phases NOT VERIFIED in this environment |
| sudo | passwordless, but apt mirrors unreachable | no system package installation possible |
| npm registry | reachable (`registry.npmjs.org` OK) | all JS dependencies + embedded PG binaries installable |
| CPU / RAM / disk | 2 cores / 3.8 GB / 20 GB free | keep dependency tree lean; sequential builds |

## 3. Toolchain decisions (frozen for V1 baseline)

| Concern | Choice | Rationale |
|---|---|---|
| Monorepo | npm workspaces, explicit build order | spec §3 structure; no pnpm/turbo bootstrap risk in this env |
| Language | TypeScript 5.9.x (pinned; NOT bleeding-edge 7.x) | compatibility with typescript-eslint / Nest / Next ecosystem |
| API | NestJS 11 + `@nestjs/platform-fastify` (Fastify 5) | spec §2 baseline |
| Web | Next.js 15 (App Router) + React 19 | spec §2 baseline; 15.x line chosen for stability over brand-new 16.x |
| DB | PostgreSQL 18 via `embedded-postgres@18.4` for tests/CI; `postgres:18-alpine` in Docker dev | spec demands REAL PostgreSQL semantics (locks, partial unique indexes, RLS); SQLite/PGlite forbidden |
| Validation | zod 4 (single source for HTTP input + OpenAPI 3.1 JSON Schema) | avoids class-validator/zod duplication; OAS 3.1 = JSON Schema dialect |
| Unit/integration tests | Vitest 3 | TS-native, fast; integration suite runs against real PG |
| Lint/format | ESLint 9 flat config + typescript-eslint 8 + Prettier 3 | standard, CI-gateable |
| Auth primitives (Phase 02+) | `node:crypto` scrypt for passwords, `jose` HS256 JWT | auditable, no native build risk |
| IDs | UUIDv7 — app generator + DB function `lanxu_uuidv7()` default | spec §2, RFC 9562; `gen_random_uuid()` yields v4 and is NOT used as business PK default |
| Money | `bigint` cents in domain, `BIGINT` in DB, integer cents on wire | spec §4.1; floats forbidden |

## 4. Risks carried into implementation

1. Docker/Compose and Android toolchains cannot run here → those phases can only be
   file-complete + lint-verified; every such claim must be marked **NOT VERIFIED** until a capable
   environment exists.
2. No Redis → any coordination code must ship with an explicit dev in-memory adapter clearly
   marked non-production, or stay blocked.
3. Real payment providers, real store SOP, wage samples are external blockers (spec §21) →
   Adapter + `EXTERNAL BLOCKER` markers, config defaults tagged
   `BUSINESS POLICY — REQUIRES PILOT VALIDATION`.
4. Single maintainer loop (agent) → phase gates recorded in `harness/phases/*.md`, never in chat
   memory alone.

## 5. Baseline decision

Greenfield bootstrap approved under Master Prompt Appendix A rules. Proceed:
repository baseline (this file) → AGENTS/PLANS/docs harness → Phase 00 → verify → repair →
Phase 01 → …
