# ADR-0003: Real embedded PostgreSQL for tests/CI

Status: Accepted (2026-10-28) · Enforces test rule "Integration tests must use real PostgreSQL"

## Context

The spec (§17.1) forbids SQLite/emulators for integration tests because lock semantics,
partial unique indexes, transactions, and RLS must match production. This build environment
has no system PostgreSQL and blocked apt egress; Docker is absent; CI must be reproducible
without services.

## Decision

- Integration tests and migration gates run against **real PostgreSQL 18 binaries** delivered
  via npm package `embedded-postgres` (platform package `@embedded-postgres/linux-x64`,
  PG 18.4) — same major as production target (spec §2: PostgreSQL 18).
- Lifecycle: `packages/testkit` boots a throwaway cluster per suite (temp data dir, random
  port), runs migrations, exposes `DATABASE_URL`; suite teardown stops + deletes.
- `DATABASE_URL` env override: if a real PG is provided (dev compose, CI service), tests run
  against it instead — embedded is the default, not a wall.
- No ORM-level shortcuts that silently diverge from PG (raw parameterized SQL via `pg`).

## Consequences

+ Tests exercise genuine FOR UPDATE, partial indexes, checksummed migrations.
+ Zero external service dependency → reliable CI.
− Suite boots add seconds per run (acceptable; one cluster per file set, not per test).
− Not byte-identical to managed Cloud PG (extensions/params) → staging smoke still required
  before release (Phase 28 gate).
