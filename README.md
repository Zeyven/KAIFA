# 澜序 LanXu StoreOS V1

Operating system for foot-bath / SPA / massage stores: rooms, technicians, service sessions,
orders, payments, members, devices, and real-time store state. Built to **run a real store** —
not a demo.

- Source of truth (frozen spec): [`docs/product/lanxu-storeos-v1-master-spec.md`](docs/product/lanxu-storeos-v1-master-spec.md)
- Start here: [`AGENTS.md`](AGENTS.md) (rules) · [`PLANS.md`](PLANS.md) (phase state) ·
  [`docs/`](docs/) (knowledge base) · [`harness/`](harness/) (phase evidence)

## Stack

| Layer | Choice |
|---|---|
| Web | TypeScript · React · Next.js (App Router) |
| API | TypeScript · NestJS + Fastify adapter (modular monolith) |
| Database | PostgreSQL 18 (`BIGINT` cents, UUIDv7, timestamptz + business_date) |
| Realtime | WebSocket with per-store monotonic `storeSeq` + replay |
| Edge | Node + PostgreSQL + Redis + Docker Compose — store-local authority while operating |
| Room kiosk | Kotlin + Jetpack Compose, Dedicated Device / Lock Task (planned) |
| Contracts | OpenAPI 3.1.2 from zod schemas |
| Money | `bigint` cents everywhere — floats forbidden |

## Quickstart (dev)

```bash
npm ci
npm run format:check && npm run lint && npm run typecheck
npm test                  # unit (vitest)
npm run test:integration  # real PostgreSQL 18 embedded (no system PG needed)
npm run build

# API dev server
npm run dev -w @lanxu/api

# With Docker available (NOT verifiable in every environment):
docker compose -f infra/docker/docker-compose.dev.yml up -d
```

## Repository layout

See the architecture map in [`AGENTS.md`](AGENTS.md). Phase records follow the template in
`harness/phases/` and verification evidence accumulates in `harness/build-log.md`.

## Status

Actively developed against the V1 phase plan in `PLANS.md`. Anything not marked `DONE` there is
not done — regardless of what code exists.

## License

Apache-2.0 (see `LICENSE`).
