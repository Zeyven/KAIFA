# Phase 02 — Authentication & Authorization

## Goal

Production login (scrypt verify + JWT), global authorization pipeline (principal →
store scope → permission codes), object-level checks, and auditable security events
(spec §10.1, §11, §16.1; OWASP API1/API2/API4/API5).

## Current State

Complete. Full verify chain exit 0 on 2026-10-29 (evidence: `harness/build-log.md`).

## Scope

- `packages/domain/src/password.ts`: scrypt (`scrypt$16384$8$1$<salt>$<hash>`, constant-time
  compare, format/version validation) + tests.
- `apps/api/src/auth/jwt.service.ts`: HS256 via `jose` (dynamic import, CJS-safe), raw
  UTF-8 secret as Uint8Array, **absolute** iat/exp (jose numbers are unix seconds — a
  relative-TTL number would mint born-expired tokens), pinned `algorithms: ['HS256']`
  (alg-confusion/`none` rejected), missing-claim tokens → 401.
- `apps/api/src/auth/auth.service.ts`:
  - `login {orgCode, username, password}` → generic 401 for unknown-user AND bad-password
    (anti-enumeration: identical code+message, dummy-hash timing equalizer), org/user
    status must be ACTIVE.
  - In-memory failed-login limiter: 5 fails/60s per (ip|org|username) → 429 RATE_LIMITED
    even with correct password afterwards; success clears the counter.
  - `last_login_at`/`failed_login_count` bookkeeping; LOGIN_SUCCESS/LOGIN_FAILED/
    LOGIN_FAILED_LOCKED/LOGIN_RATE_LIMITED rows in `security_events`.
  - `effectivePermissions(userId, storeId)`: fresh from DB per request (never trusted from
    JWT) via employees→employee_roles(store-scoped)→role_permissions; no active employee ⇒
    UNAUTHORIZED_SCOPE.
- `apps/api/src/auth/guards/app-auth.guard.ts` — single global `APP_GUARD`, deterministic
  order: `@Public` skip → JWT verify → store scope (`X-Store-Id` must exist, belong to the
  JWT org, be ACTIVE, and have the principal's ACTIVE employment) → permission ALL-of from
  `@RequirePermissions` → AUTHZ_DENIED `security_events` on every denial.
- Decorators (`@Public`, `@RequirePermissions`, `@NoStoreScope`) in
  `apps/api/src/common/decorators.ts`; fastify augmentation (`principal/authStoreId/
  actorEmployeeId/permissionCodes`) in `common/http-context.ts`.
- `CoreModule` (global): pool + audit + JWT + auth providers + guard registration.
  All constructor deps use explicit `@Inject` — tests run under esbuild (no
  `emitDecoratorMetadata`), prod and test must behave identically.
- Health endpoints marked `@Public` (LB/orchestrator probes must not need a token).
- Readiness service refactored onto the shared `PG_POOL` (single pool provider,
  `DatabaseModule` global; `PoolCloser` ends it on teardown).

## Non-goals

Refresh tokens/sessions (V1 = long-enough access token), Redis-backed limiter
(single-instance limiter is honest; distributed limiter lands with edge/queue phases),
WebAuthn/SSO, device tokens (Phase 19).

## Files

`packages/domain/src/password.ts` + `password.test.ts` ·
`apps/api/src/{common/decorators.ts, common/http-context.ts, db/pg.module.ts,
core/core.module.ts, auth/jwt.service.ts, auth/auth.service.ts, auth/auth.controller.ts,
auth/guards/app-auth.guard.ts, audit/audit.service.ts, common/store-events.ts}` ·
`apps/api/src/auth/auth.int.test.ts` · health module updates (`@Public`, readiness via
shared pool) · `apps/api/package.json` (+`jose@^6.2.13`).

## Architecture Decisions

- One global guard instead of per-route guards: authorization order is testable as a
  single contract (public→JWT→scope→permissions); object-level checks still run inside
  each command service (defense in depth, spec §11/OWASP API1).
- Permissions resolved per request from the DB, scoped by `store_id` — role grants are
  store-scoped rows (`employee_roles(store_id)`), so revocation is effective immediately
  and per store.
- Login failures are indistinguishable (unknown vs wrong password) by construction;
  rate-limit key includes org+username+ip; limiter state is per-process (documented
  limitation, becomes Redis-backed with the queue phase).
- Audit + security writers take the caller's transaction client when inside a command
  (same-tx evidence, invariant I24) — `AuditService.record(client, …)`.

## Acceptance Criteria

1. `npm run verify` → 0 (format, lint, typecheck, unit 47, integration 36, openapi, build) — ✅
2. Login success issues usable JWT; tampered/expired/claim-less tokens → 401 — ✅
3. Wrong password ≡ unknown user (code+message) — ✅
4. 5 fails/60s → 429 RATE_LIMITED — ✅
5. Cross-store/cross-org `X-Store-Id` → 403 UNAUTHORIZED_SCOPE; missing permission → 403
   FORBIDDEN naming the missing code — ✅
6. Cross-store object read → 404 (no existence leak) — ✅
7. All denials/failures recorded in append-only `security_events` — ✅

## Tests

Integration `apps/api/src/auth/auth.int.test.ts` (10) against real PostgreSQL 18 +
full HTTP pipeline: login success/store list, wrong-password ≡ unknown-user, missing/
tampered/**forged-expired** JWT (same secret — exp enforcement, not just signature),
missing/foreign store scope, IDOR 404 (store-B clerk vs store-A room), FORBIDDEN with
missing code listed, rate limit (5→429 even with valid password), security_events
evidence (LOGIN_FAILED≥5, LOGIN_SUCCESS, AUTHZ_DENIED), `/v1/auth/me` bootstrap with
and without store context. Unit: password suite (5).

## Security Considerations

- HS256 pinned server-side; secret from validated env (≥48 chars via config schema);
  JWT carries identity only — never permissions or store scope.
- Constant-shape login failures + dummy-hash timing equalizer; no user enumeration.
- Server-side store/permission checks on every request; client-supplied ids untrusted.
- AUTHZ_DENIED rows carry actor + URL + reason for forensics (append-only table).

## Migration Considerations

None specific to 02 (uses 0001 identity tables). 0002 (rooms/audit/events) lands with
Phase 03 in the same batch.

## Rollback

Revert the API code; schema unchanged by this phase. JWTs issued remain valid until
expiry but become useless once the guard code is reverted (routes return 404/401).

## Risks

- In-memory rate limiter resets on restart and is per-instance — acceptable for single
  node V1; becomes ineffective behind a load balancer until the Redis phase (marked).
- `JWT_ACCESS_TTL_SECONDS` default 3600 without refresh: long-lived tablet sessions may
  re-login — FrontDesk (07) will surface expiry handling.

## Definition of Done

implementation ✅ · tests ✅ · lint ✅ · typecheck ✅ · build ✅ · migration verified ✅ ·
security reviewed ✅ · docs updated ✅ · no known Blocker ✅

## Verification Result

**DONE** — `npm run verify` exit 0 (2026-10-29), details in `harness/build-log.md`
(Phase 02/03 section). `npm audit --audit-level=high` → 0.
