# Runbook — Edge Outage / Internet Loss

Authority while open: **Store Edge** (spec §12.1). Symptoms: Cloud unreachable from store,
WS to Cloud dead, sync lag metric climbing. Store operations MUST continue.

## Detect

- Alert: `edge_sync_lag_seconds > 120`, `edge_outbox_pending` rising, Edge `/ready` degraded
  mode flag, store reports "总部系统打不开".
- Distinguish: (a) internet down, (b) Cloud down, (c) Edge local down (worse — see bottom).

## Internet / Cloud down (expected operating mode)

1. Confirm Edge `/health/ready` = OK (local PG reachable) → operations continue:
   开房 / 排钟 / 上下钟 / 加钟 / 商品 / 房态 / 现金结账.
2. Inform store: 线上支付、跨店钱包、第三方核销 show explicit "离线不可用" —
   do NOT let staff simulate online payments (spec §2.2).
3. Watch `edge_outbox_pending` — events queue locally; publisher retries automatically.
4. On recovery: publisher drains in order; verify
   `edge_outbox_pending → 0`, lag → 0, no `inbox_events.conflict` rows.
5. If conflicts appear (rare, non-mergeable): do not auto-force; escalate per
   `offline-sync.md` conflict rules with manual resolution.

## Edge local down (PG/Redis/box dead)

1. Switch to documented degraded process: paper 大厅记录 on the printed fallback form (store
   keeps printed pads) OR restore Edge from last snapshot.
2. Rebuild Edge host from compose + latest cloud-pulled config (Edge pulls config snapshot
   periodically; last snapshot is on disk).
3. After recovery, transcribe any paper actions through supervised back-entry commands (each
   back-entry is audited, `source=manual_backfill`, normal state machines still enforced).
4. If state can't be reconciled safely → Phase 22 reconciliation flagged rows + manager review.

## Never

- Never wipe the outbox to "fix" lag (I21/I22).
- Never replay raw SQL edits around state machines — use commands so audit/events hold.
- Never mark sync healthy because the queue looks quiet — check last-success timestamp.

## Evidence

Simulated 30-min outage test belongs to Phase 21; results appended to
`harness/phases/21-offline-operation.md`.
