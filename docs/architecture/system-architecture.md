# System Architecture — LanXu StoreOS V1

Baseline: Master Prompt §2–3. Modular monolith, two planes (Cloud + Store Edge).

## Topology

```
LanXu Cloud  (apps/api on cloud infra)
   │  HTTPS / WSS  (OpenAPI 3.1 · WebSocket /store/v1/realtime)
   ▼
LanXu Store Edge  (apps/edge: Node + PG + Redis + Docker Compose — 营业权威 while operating)
   │
   ├── FrontDesk web (apps/web → Edge local API when operating)
   ├── Room Android kiosk (apps/room-android)
   └── Staff devices
```

Authority split is a hard rule (`docs/architecture/offline-sync.md`):
- Cloud authoritative: tenancy, org config, HQ control plane, multi-store reports, backups.
- Edge authoritative while store is open: room/technician/live-session/order state, events.
- Provider truth (payment/refund final state) always comes from the provider via server-side
  verification — never from a client, never assumed offline.

## Deployment units

| Unit | Runtime | Contents |
|---|---|---|
| `apps/api` | Node 22, NestJS 11 + Fastify 5 | modular monolith, all bounded modules |
| `apps/web` | Next.js 15 (App Router) | FrontDesk / Manager / Boss / Staff |
| `apps/edge` | Node + PG 18 + Redis | local API mirror of营业 subset + sync worker (Phase 19/20) |
| `apps/room-android` | Kotlin + Compose | kiosk, Device Owner / Lock Task (Phase 09/10) |
| `packages/*` | TS libraries | shared contracts, pure domain, db, config, observability, testkit, ui |

## Module rules

1. Modules live in `apps/api/src/modules/<name>/` with own services/repos; cross-module reads
   go through a module's public service interface — no ad-hoc joins across domains to hide
   coupling.
2. Shared PostgreSQL, one schema for V1; isolation is by `organization_id`/`store_id` columns +
   repository discipline + RLS as defense depth (never as the only check).
3. Transactions: the guard validation, state mutation, event/outbox insert, and audit insert
   happen in ONE transaction. Money paths use explicit row locks (`SELECT … FOR UPDATE`) or
   documented serializable+retry islands — never a blanket SERIALIZABLE.
4. Realtime events originate from committed outbox/domain events, never from inside controllers.

## Request path (Cloud API)

```
client → X-Request-Id (+ Authorization)
      → auth guard (JWT) → permission guard → store-scope guard → object authorization
      → zod-validated input → domain command (state machine guards, one txn)
      → response envelope {data}|{error:{code,message,requestId}} (OpenAPI contract)
```

Errors: clients branch on `error.code` only (see `docs/architecture/api-contract.md`).

## Observability

Every request carries `requestId`/`traceId`; structured logs carry
service/store/actor/device/action/resource/result/latency with masking; metrics cover API
latency/errors, DB pool, WS clients, outbox pending, sync lag, device online, payment failures,
active rooms/sessions. `/live` = process alive; `/ready` = can actually serve (DB reachable,
migrations current). OpenTelemetry hooks live in `packages/observability`.

## Environments

| Env | DB | Notes |
|---|---|---|
| dev/CI (this repo) | embedded PostgreSQL 18.4 (real binaries from npm) | integration tests + migration gates |
| dev (Docker) | `postgres:18-alpine` + `redis:8-alpine` | `infra/docker/docker-compose.dev.yml`, NOT VERIFIED without Docker |
| edge | bundled PG+Redis in compose | offline authority |
| cloud prod | managed PG 18, daily backup + PITR | Phase 26 restore drill required before "ready" |

## Deliberate omissions (V1)

No message broker (outbox tables + workers instead), no microservice split, no k8s, no
Kafka/Debezium. Complexity only buys its way in with a written ADR in `docs/adr/`.
