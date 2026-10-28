# SECURITY.md — LanXu StoreOS

## Reporting

Report suspected vulnerabilities privately to the repository maintainers (GitHub Security
Advisories once the repo is public). Do not open public issues for exploitable financial or
authorization bugs.

## Security posture (V1)

Threat model: `docs/security/threat-model.md` · Authorization design:
`docs/security/authorization.md` · Device kiosk: `docs/security/device-security.md` ·
Payments: `docs/security/payment-security.md`.

Non-negotiable invariants (enforced by tests; breaking one is a release Blocker):

1. **Object-level authorization** — every read/write re-validates organization/store ownership
   from the authenticated principal. Cross-tenant/cross-store IDOR (OWASP API1) is a Blocker.
2. **Financial integrity** — money is integer cents (`bigint`/`BIGINT`); duplicate payment,
   duplicate refund, double wallet deduction, negative wallet balance, or ledger/balance
   divergence is a Blocker.
3. **Append-only history** — Payment, Refund, wallet ledger, commission entries, audit logs are
   never rewritten to "fix" numbers; corrections are new compensating records.
4. **Server-verified payment state** — client-reported payment success is never trusted; provider
   callbacks are signature-verified, amount/merchant/currency-checked, and idempotent.
5. **Audit** — high-risk actions (approvals, refunds, wallet/commission adjustments, permission
   and device changes, forced scheduling, service-time overrides) write audit rows that the
   normal application role cannot DELETE.
6. **Secrets** — no payment private keys, DB passwords, or tokens in repo, APK, logs, or audit
   payloads. Phone numbers stored hash+encrypted, masked in logs.
7. **Rate limiting** on login, payment, refund, device enrollment, and public lookup endpoints.
8. **Fail closed** — production boot fails if a fake payment provider or a dev/default secret is
   detected.

## Supported versions

| Line | Supported |
|---|---|
| V1 (this branch) | ✅ actively developed |

## Dependency policy

CI runs `npm audit --audit-level=high` as a gate (configurable; see `.github/workflows/ci.yml`).
Pinned majors are reviewed when upgrading. Docker images track pinned minor tags
(`postgres:18-alpine`, `redis:8-alpine`, `node:22-slim`).
