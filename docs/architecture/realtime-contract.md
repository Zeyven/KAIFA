# Realtime (WebSocket) Contract — LanXu StoreOS V1

Normative: Master Prompt §8. Implementation: Phase 18.

## Endpoint

`wss://<host>/store/v1/realtime` (Edge while store open; Cloud mirrors for remote viewers).

Auth: same JWT as HTTP (query param `token` discouraged — use `Sec-WebSocket-Protocol` bearer or
short-lived ticket; decision recorded in Phase 18 ADR). Store scope enforced at upgrade:
subscription limited to stores the principal may read.

## Event envelope (frozen)

```json
{
  "eventId": "0192f…uuidv7",
  "storeId": "0192f…uuidv7",
  "storeSeq": 128456,
  "type": "service.started",
  "occurredAt": "2026-10-28T12:00:00Z",
  "aggregate": {"type": "service_session", "id": "0192f…"},
  "version": 4,
  "payload": {}
}
```

- `storeSeq`: per-store monotonic bigint, gap-free, allocated in the SAME transaction as the
  business mutation (defeats "commit then publish" races).
- `eventId`: UUIDv7, globally unique, client-dedupes replays.
- `version`: aggregate version after the transition.

## Delivery guarantees & client algorithm

1. Client persists `lastStoreSeq` per store.
2. On connect/reconnect: send `{ "type": "resume", "after": lastStoreSeq }`.
3. Server replays buffered events with `storeSeq > after` in order.
4. If `after` is outside the retention window: server replies
   `{ "type": "resync_required" }` → client fetches REST snapshot
   (`GET /v1/…` boards) with its `storeSeq` watermark, applies snapshot, then resumes from the
   returned seq. **Never assume the socket is lossless; never apply events older than the
   snapshot watermark (idempotent by `eventId` + seq check).**
5. Server heartbeat ping every 25 s; client reconnect with backoff + jitter.

## Event types (V1 initial registry)

| Domain | Types |
|---|---|
| Rooms/Visits | `room.updated`, `visit.opened`, `visit.closed` |
| Technicians | `technician.status_changed`, `technician.queue_changed` |
| Service | `service.assigned`, `service.acknowledged`, `service.arrived`, `service.started`, `service.extended`, `service.completed`, `service.terminated`, `service.cancelled`, `service.changed_technician` |
| Orders/Money | `order.updated`, `order.paid`, `payment.updated`, `refund.updated` |
| Requests/Devices | `service_request.created`, `service_request.completed`, `device.status_changed` |
| Control | `hello`, `resume`, `resync_required`, `error` |

Registry: `packages/contracts/src/events.ts`. New event = registry entry + docs line; clients
ignore unknown types (forward compatible).

## Ordering & backpressure

- Per-socket send order = `storeSeq` order.
- Slow consumer: server buffers capped (e.g. 1024 events) then forces `resync_required` —
  never unbounded memory, never dropped-without-telling.

## Testing (Phase 18 gates)

Replay correctness after simulated disconnect · duplicate `eventId` dedupe · retention expiry →
resync path · seq monotonicity under concurrent writers (real PG) · auth scope rejection.
