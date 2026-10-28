# Offline Sync — LanXu StoreOS V1

Normative: Master Prompt §12. Implementation: Phase 19 (Edge runtime), Phase 20 (outbox),
Phase 21 (offline Golden Path). Schema: `outbox_events`, `inbox_events`, `sync_checkpoints`.

## Authority matrix

| Data | Authority | Offline behavior |
|---|---|---|
| Rooms / technicians / service sessions / orders (store-open ops) | **Store Edge** | fully operational without internet |
| Org/tenant config, HQ control plane, multi-store reports | **Cloud** | reads served from last-synced cache; writes queued/ rejected with explicit error |
| Payment provider final state | Provider + server-verified state | online-only; UI must say 离线不可用 — never fake success |
| Cross-store wallet | Cloud/central | offline default: restricted (config flag), never silent |
| Device enrollment/binding | Cloud | offline: already-bound device keeps working; new enrollment online-only |

## Transactional outbox (non-negotiable)

```
BEGIN
  <business mutation + guards + audit>
  INSERT outbox_events (event_id uuidv7, aggregate, type, payload, occurred_at)
COMMIT
-- publisher (separate worker) reads unpublished → POSTs to Cloud inbox → marks published
```

Forbidden: "commit DB, then publish" two-phase hand-rolling — a crash between steps loses the
event forever (spec §12.2). The outbox row and the business row share fate in one txn.

## Delivery & idempotency

```
Edge outbox → Cloud POST /v1/edge/inbox (batch, ordered per store)
           → Cloud inbox_events UNIQUE(event_id) dedupe → apply in txn → ACK
           → Edge marks published (retry until ACK; at-least-once)
```

- `eventId` is the UUIDv7 of the outbox row — global unique; duplicates are ACKed as
  already-applied (idempotent).
- Ordering per store by `store_seq` (same sequence that feeds WebSocket).
- Retries with exponential backoff + jitter; poison events surface in metrics/alerts, never
  dropped silently.
- Crash simulation test: kill worker mid-publish → restart → no loss, no dupes (Phase 20).

## Conflict rules

- NO last-write-wins for Payment / Wallet / ServiceSession / Scheduling / Commission / Refund.
  If Cloud sees a conflicting non-mergeable event → hold in `inbox_events` with
  `conflict` status → surface for manual resolution (runbook).
- Config rows use optimistic concurrency: `version` / `If-Match` → 409 on mismatch.
- Edge-originated real business events are NEVER overwritten by later Cloud config pushes.
- Timestamps: record both `client_occurred_at` and `server_received_at`; money/ordering uses
  server-authoritative time. Display order uses `store_seq`.

## Client reconnection (realtime, see realtime-contract.md)

Persist `lastStoreSeq`; on reconnect request `after=lastSeq`; if retention window missed →
fetch snapshot then continue from snapshot seq. Never assume WS is lossless.

## Health & observability

Metrics: `edge_outbox_pending`, `edge_sync_lag_seconds`, `cloud_inbox_conflicts`,
`edge_last_success_timestamp`. `/ready` on edge degrades (but keeps serving营业) when Cloud is
down — local DB is the authority while open.
