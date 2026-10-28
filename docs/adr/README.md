# ADRs — Architecture Decision Records

Lightweight format: context → decision → consequences. Numbered `NNNN-kebab-title.md`.
Required whenever: an invariant changes (see `docs/architecture/invariants.md`), a baseline
technology is swapped, a sync/financial semantic is altered, or a security control is reduced.

| ADR | Title | Status |
|---|---|---|
| 0001 | Modular monolith on shared PostgreSQL | Accepted |
| 0002 | Money as integer cents (bigint) end-to-end | Accepted |
| 0003 | Real embedded PostgreSQL for tests/CI | Accepted |
| 0004 | UUIDv7 via DB function + app generator | Accepted |
| 0005 | zod as single source for validation + OpenAPI 3.1 | Accepted |
