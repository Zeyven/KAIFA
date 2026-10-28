# Runbook — Rollback

Three rollback planes: application release, database migration, edge/config. Principle:
**roll forward when possible** (reversible migrations), break-glass reverse only with evidence.

## 1. Application release rollback

1. Identify last known good image/commit (release tag from CI).
2. Roll orchestration back (compose/k8s manifest — k8s not in V1 scope; compose:
   `docker compose pull && up -d` with pinned previous tag).
3. Gate: `/health/ready` OK + smoke (login, board load, one dry-run command).
4. If new release ran new migrations → see plane 2; app rollback + incompatible schema = outage.

## 2. Migration rollback policy (spec §18.2)

- Every migration declares in its header: reversible? (Y/N), lock risk, compat window,
  reverse strategy.
- Reversible (Y): `npm run migrate -- down 1` runs the paired `.down.sql`; CI proves
  down→up round-trip on a fresh DB (Phase 01 gate).
- Irreversible (destructive steps): split into expand → migrate-copy → contract across
  releases; contract step only after a full release cycle of compatibility. NEVER ship
  destructive schema + incompatible code in one irreversible push.
- Data-bearing reversals: restore from pre-migration snapshot if `down` cannot reconstruct.

## 3. Edge / store config rollback

- Config pushes carry `version`; rollback = push previous version (409-aware optimistic
  concurrency). Business events already recorded on Edge are NEVER rolled back by config
  (I23) — config rollback must not touch营业 rows.

## Financial incident rollback

There is NO "rollback" for money history: corrections = compensating records (refunds,
adjustments, audit), per I14/I20. For a bad deploy that wrote wrong money rows: stop writes,
assess with reconciliation, then compensating entries approved by finance — never UPDATE/DELETE.

## Evidence requirement

Each executed rollback: what/when/why/verification pasted into
`harness/reviews/rollback-<date>.md`. Unevidenced rollback claims count as NOT VERIFIED.
