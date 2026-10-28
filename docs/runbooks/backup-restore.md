# Runbook — Backup & Restore (Cloud PostgreSQL 18)

Status: procedures designed; **Restore Drill NOT VERIFIED** until executed in an environment
with cloud PG access (Phase 26 gate — "配置了备份" ≠ "可恢复", spec §18.3).

## Backup design

- Daily full base backup + continuous WAL archiving (PITR) on the managed Cloud PostgreSQL 18.
- Retention: ≥ 30 days daily, WAL ≥ 7 days (tune with pilot RPO sign-off).
- Encrypted at rest; backup access is break-glass audited.
- Edge local DB: snapshot before every schema migration; edge is not a long-term backup
  (Cloud is), but offline营业 data must survive edge disk swap — see edge runbook.

## PITR targets

| Scenario | Target | Note |
|---|---|---|
| RPO (cloud) | ≤ 5 min | WAL cadence |
| RTO (point restore) | ≤ 60 min | drill-measured, not assumed |

## Restore drill (Phase 26 acceptance — evidence stored in harness)

1. Pick random recent timestamp T in staging copy.
2. Restore into a fresh instance (`gcloud/sql` / `pgbackrest restore` per provider — exact
   commands recorded when infra exists).
3. Run `npm run migrate -- status` → must show all migrations applied as-of T or catch-up plan.
4. Run verification queries: wallet balance vs ledger sums, order paid vs payments,
   `outbox_events` continuity, one-active-visit/one-active-session invariants.
5. Run smoke E2E (Golden Path) against restored DB.
6. Record wall-clock, failures, and deviations in `harness/reviews/restore-drill-<date>.md`.

## Restore (operational)

- Casual data loss (row-level): prefer compensating business actions (audit-friendly) over DB
  surgery; surgery requires two-person approval + written ADR.
- Full PITR: stop API → restore to T → run `migrate -- status` → point API → run smoke →
  announce; while API is down Edge continues offline营业 and re-syncs after.

## Anti-patterns

Never "restore over" a live prod DB without snapshot; never delete WAL; never claim drill done
without the evidence file.
