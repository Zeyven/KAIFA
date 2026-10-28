# ADR-0001: Modular monolith on shared PostgreSQL

Status: Accepted (2026-10-28) · Supersedes: none

## Context

V1 must deliver an operationally complete store OS (rooms→payments) with a small team and an
agent-driven workflow. Microservices would multiply deploy, consistency, and testing cost
before any product risk is retired. Spec §2.1 mandates modular monolith.

## Decision

- One deployable API (`apps/api`), modules under `src/modules/<module>/` with private
  internals and narrow public services.
- Shared PostgreSQL; cross-module access through public interfaces, not ad-hoc joins.
- Async decoupling only via transactional outbox tables — no broker in V1.

## Consequences

+ Single transaction spans guard/audit/outbox (strong correctness story).
+ Simpler ops and debugging; one migration timeline.
− Module boundaries rely on discipline (lint: import direction rules) rather than process
  isolation. Violations found in review become follow-ups.
− Scaling out = vertical first; horizontal split deferred (needs ADR).
