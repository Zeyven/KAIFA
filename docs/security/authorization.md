# Authorization (RBAC + Object-Level) — LanXu StoreOS V1

Normative: Master Prompt §11 + §7. OWASP API1 (BOLA) is treated as a Blocker-class risk.
Implementation: `apps/api/src/common/guards` (auth → permission → store-scope → object) and
service-level ownership assertions.

## Layers (all must pass; checked in this order)

1. **Authentication** — valid JWT (`jose`, HS256 dev / KMS-ready), `sub` = user id, claims:
   `orgId`, `empId`, `roles[]` (roles are hints only — permissions always resolved
   server-side).
2. **Function-level permission** — route declares required permission code(s) from
   `permissions` table via `role_permissions` (resolved fresh per request or short-cached with
   invalidation on grant change). Deny → 403 `FORBIDDEN`.
3. **Store scope** — `X-Store-Id` (or route-derived store) must belong to the principal's org
   AND be one the employee may act for. Mismatch → 403 `UNAUTHORIZED_SCOPE`.
4. **Object-level authorization** — load target row, re-derive `organization_id`/`store_id`
   and relation (session belongs to this visit? payment to this order?). Foreign
   org/store → `404 NOT_FOUND` (no existence leak). Same-store but relationally wrong →
   422/403 per resource doc.
5. **Conditional approval (△)** — threshold checks (e.g. discount ≥ configured cents) attach
   an `approval_requests` record; acting without approval → 422 `APPROVAL_REQUIRED`.

Permission exists ≠ may operate on any object (spec §11).

## Permission matrix (frozen baseline, spec §11)

| Capability | frontdesk | cashier | clockroom | technician | supervisor | manager | finance | boss |
|---|---|---|---|---|---|---|---|---|
| room.open | ✓ | ✓ | – | – | ✓ | ✓ | – | ✓ |
| room.move | ✓ | – | – | – | ✓ | ✓ | – | ✓ |
| schedule.assign (normal) | ✓ | – | ✓ | – | ✓ | ✓ | – | ✓ |
| schedule.assign.force | – | – | △ | – | ✓ | ✓ | – | ✓ |
| service.self_start_stop | – | – | – | ✓ | ✓ | ✓ | – | ✓ |
| service.time_override | – | – | – | – | △ | ✓ | – | ✓ |
| order.checkout | ✓ | ✓ | – | – | ✓ | ✓ | – | ✓ |
| order.discount | △ | ✓ | – | – | ✓ | ✓ | – | ✓ |
| refund.request | ✓ | ✓ | – | – | ✓ | ✓ | ✓ | ✓ |
| refund.approve | – | – | – | – | △ | ✓ | ✓ | ✓ |
| wallet.adjust | – | – | – | – | – | △ | ✓ | ✓ |
| commission.adjust | – | – | – | – | – | ✓ | ✓ | ✓ |
| rbac.manage | – | – | – | – | – | ✓ | – | ✓ |
| audit.read | – | – | – | – | ✓ | ✓ | ✓ | ✓ |

△ = allowed only when threshold satisfied / approval requested (per store config).

System roles seed from this table in migration; codes are stable strings
(`role.frontdesk`, `role.cashier`, …; `perm.room.open`, …). UI hides actions the principal
lacks, but hiding is UX only — server enforces.

## Rules of engagement

- Guards live on routes; **ownership re-checks live inside the command service** (belt and
  suspenders — route-level alone is insufficient when ids move between layers).
- Never accept `organizationId` from the client as authority. Client `storeId` etc. are
  lookup hints, always validated.
- Technician self-service endpoints only expose the caller's own technician row
  (`empId → technicians` mapping enforced in query).
- Device credentials act with a narrow device-role scope bound to ONE room (Phase 09+).
- Every grant/revoke/role change writes `audit_logs` (Phase 23 hardening).

## Test obligations

Each phase adding endpoints must add: (a) permission denial matrix case, (b) cross-store 404
case, (c) cross-tenant 404 case, (d) any conditional-approval case. Suites live next to the
integration harness (real PG), see `packages/testkit`.
