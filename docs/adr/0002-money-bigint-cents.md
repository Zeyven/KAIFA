# ADR-0002: Money as integer cents (bigint) end-to-end

Status: Accepted (2026-10-28) · Enforces invariants I9/I12/I15

## Context

RMB arithmetic on floats (JS `number`, SQL `double`, PG `money`) causes rounding drift and is
declared a Blocker by the spec (§4.1, §22.1).

## Decision

- Domain: TypeScript `bigint` cents via `packages/domain/money.ts` (explicit
  add/sub/mulRate with documented rounding: HALF_UP on final division, intermediate
  products exact).
- DB: `BIGINT` cents columns named `*_cents`; `numeric(18,4)` reserved for quantities only.
- Wire/OpenAPI: integer `cents` (JSON numbers safe < 2^53; validation rejects non-integers
  and magnitudes ≥ 2^53).
- Percentages: basis points (`_bps` integer) for rates (avoids 0.1 float pitfalls);
  `PERCENT_OF_NET` commission parses to bps at rule-authoring time.
- Formatting (¥ display) only at UI edge; never round-trip formatted strings into domain.

## Consequences

+ Exact arithmetic; reconciliations are integer equality checks.
+ Straightforward property tests (sum invariants).
− Every conversion at boundaries must be explicit — zod schemas enforce integer/limits.
