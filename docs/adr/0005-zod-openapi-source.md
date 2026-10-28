# ADR-0005: zod as single source for validation + OpenAPI 3.1

Status: Accepted (2026-10-28) · Enforces contract rule (spec §2, §7)

## Context

We need an OpenAPI 3.1.2 contract (spec baseline) that cannot drift from runtime input
validation. Nest's class-validator route decorators would create a second schema language.

## Decision

- All request/response schemas are zod v4 schemas in `packages/contracts`, exported both as
  TS types (`z.infer`) and JSON Schema via `z.toJSONSchema(..., { target: 'draft-2020-12' })`
  — the dialect OpenAPI 3.1 embeds.
- A generator script (`npm run openapi`) assembles paths + schemas →
  `docs/architecture/openapi.json`; CI diffs regenerated output vs committed file (gate
  activates when routes register in Phase 07+).
- Runtime: a single Nest `ZodValidationPipe` validates bodies/query/params → 400
  `VALIDATION_FAILED` with `details[]`.
- Error envelope itself is a zod schema (`packages/contracts/src/errors.ts`) shared by the
  exception filter and clients.

## Consequences

+ One schema = docs + types + runtime guard; drift impossible by construction.
− Zod-to-JSON-Schema fidelity edge cases (refs, branding) must be checked in generator tests —
  a small contract test asserts the emitted document parses as OAS 3.1 structure.
