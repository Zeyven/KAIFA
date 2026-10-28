# HTTP API Contract — LanXu StoreOS V1

Normative: Master Prompt §7. Machine contract: OpenAPI 3.1.2, generated from zod schemas in
`packages/contracts` (JSON Schema dialect = OAS 3.1 `schema` objects).

## Envelope

Success — `200/201`: `{"data": <payload>}`

Error — `4xx/5xx`:

```json
{"error": {"code": "SERVICE_INVALID_STATE", "message": "…", "requestId": "…"}}
```

- Clients branch on `error.code` ONLY; `message` is human text, may change/be localized.
- `requestId` echoes `X-Request-Id` (or is generated as UUIDv7) and appears in every log line.
- Validation failure → `400 VALIDATION_FAILED` with `details[]` (path, code) — no zod internals leaked.
- Unknown route → 404 `NOT_FOUND`. Never leak existence of resources across tenants (403 vs 404
  policy: same-store visible-but-forbidden = 403; other-store/tenant = 404-shaped `NOT_FOUND`).

## Status code semantics (frozen)

| Code | Meaning |
|---|---|
| 200/201 | success / created |
| 202 | accepted for async processing |
| 400 | malformed/invalid input |
| 401 | unauthenticated |
| 403 | authenticated but no permission/scope |
| 404 | not found / existence not disclosed |
| 409 | concurrency (version), idempotency conflict, unique violation |
| 422 | valid request, illegal state transition / guard failure (`error.code` explains) |
| 429 | rate limited (`Retry-After`) |
| 500 | internal |
| 503 | dependency unavailable (DB down, provider outage) |

## Headers

- `Authorization: Bearer <JWT>` — required except `/v1/auth/login`, `/health/live`,
  `/health/ready`, device enrollment endpoints (own credential flow).
- `X-Request-Id` — optional in, always out.
- `Idempotency-Key` — REQUIRED on all money/dangerous writes: payments, refunds, recharge,
  wallet adjustments, assign, checkout. Missing → 400. Reuse with different body →
  409 `IDEMPOTENCY_CONFLICT`. Same key + same body → replay stored result (200 with original
  outcome).
- Store scope: `X-Store-Id` (or derived from JWT claim) must be a store the principal may act
  for; mismatch → 403 `UNAUTHORIZED_SCOPE`. Client-supplied store/room ids are re-validated
  against DB on every command.

## Pagination

Lists: cursor-based — `?limit=50&cursor=<opaque>` → `{"data":{"items":[…],"nextCursor":"…"}}`.
Cursor = base64 of `(sort_key, id)`; stable under concurrent inserts.

## Core endpoints (spec §7.3 — phases 03–16)

Rooms · Technicians · Scheduling · Service sessions · Orders/Payments/Refunds ·
Customers/Members — as listed in the master spec. Additionally in V1 skeleton:

- `GET /health/live` → `{"data":{"status":"live"}}` (process alive)
- `GET /health/ready` → readiness: DB reachable + migrations current → else 503
- `POST /v1/auth/login` → token (rate-limited); `GET /v1/auth/me` → principal + permissions
- `GET /v1/openapi.json` → served contract (CI validates it against route schemas)

## Versioning

- Breaking change ⇒ new major under `/v2`. Additive fields are non-breaking.
- CI gate: regenerate OpenAPI from `packages/contracts`, diff against committed
  `docs/architecture/openapi.json`; drift fails the build (Phase 07+ activates diff check;
  generator lands in Phase 00 skeleton).
