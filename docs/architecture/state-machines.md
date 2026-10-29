# State Machines — LanXu StoreOS V1

Normative tables: Master Prompt §5. Implementation home: `packages/domain` (pure, fully unit
tested) — services only call `transition(...)`; HTTP layer never writes state columns.

Shared rules for ALL machines:

1. Transitions are explicit allow-lists `{from} --{event}--> {to}` with guards. Unknown
   event/state pair → `INVALID_STATE_TRANSITION` (HTTP 422) with `error.code`.
2. Guard failure with legal event in wrong conditions → business code (e.g.
   `ROOM_NOT_ELIGIBLE`), also 422.
3. Concurrency: command re-reads row `FOR UPDATE`, revalidates guard, bumps `version`.
   Version mismatch → 409.
4. Every accepted transition appends to the domain/audit history table in the same txn.
5. Clients cannot write state directly (no generic `PATCH /rooms/:id {status}`).

## 1. Room (`rooms.operational_state`)

```
VACANT_CLEAN ──OPEN_VISIT──▶ OCCUPIED_WAITING_SERVICE
RESERVED ──GUEST_ARRIVED──▶ OCCUPIED_WAITING_SERVICE
OCCUPIED_WAITING_SERVICE ──SERVICE_STARTED──▶ IN_SERVICE
IN_SERVICE ──ALL_SERVICES_COMPLETED──▶ WAITING_CHECKOUT   (guard: no running session)
WAITING_CHECKOUT ──ORDER_PAID──▶ DIRTY                    (guard: balance == 0)
DIRTY ──CLEANING_STARTED──▶ CLEANING                      (guard: cleaner permission)
CLEANING ──CLEANING_COMPLETED──▶ VACANT_CLEAN              (guard: checklist passed)
VACANT_CLEAN|OCCUPIED_WAITING_SERVICE|DIRTY ──MAINTENANCE_START──▶ MAINTENANCE
MAINTENANCE ──MAINTENANCE_END──▶ VACANT_CLEAN              (guard: inspection)
VACANT_CLEAN ──DISABLE──▶ DISABLED ;  DISABLED ──ENABLE──▶ VACANT_CLEAN
```

Forbidden (non-exhaustive, tested): `IN_SERVICE → VACANT_CLEAN`, `IN_SERVICE → DIRTY`,
`DISABLED → OPEN_VISIT`, `CLEANING → OCCUPIED_*`.

## 2. Technician

```
OFF_DUTY ──CLOCK_IN──▶ AVAILABLE
AVAILABLE ──ASSIGN──▶ ASSIGNED ──ACK──▶ GOING_TO_ROOM ──ARRIVE──▶ WAITING_START
WAITING_START ──START_SERVICE──▶ SERVING ──COMPLETE──▶ RECOMPUTE
AVAILABLE ──BREAK_START──▶ BREAK ──BREAK_END──▶ AVAILABLE
AVAILABLE ──LOCK──▶ LOCKED ──UNLOCK──▶ AVAILABLE
eligible ──CLOCK_OUT──▶ OFF_DUTY
```

`RECOMPUTE` (spec §5.2): after COMPLETE, state = f(shift ended?, next reservation?, locked?,
break?, paused?, next queued assignment?) — never unconditional AVAILABLE.

## 3. ServiceSession

```
DRAFT ──assign──▶ ASSIGNED ──acknowledge──▶ ACKNOWLEDGED ──arrive──▶ ARRIVED
ARRIVED ──start──▶ STARTED
STARTED ──extend──▶ STARTED
STARTED ──change-technician──▶ ASSIGNED   (to new technician; old freed)
STARTED ──nearing-end──▶ ENDING_SOON ──complete──▶ COMPLETED
STARTED ──complete──▶ COMPLETED
DRAFT|ASSIGNED ──cancel──▶ CANCELLED
ASSIGNED ──reject──▶ DRAFT|CANCELLED (per config)
STARTED and beyond ──*──▶ ONLY via terminate (+refund/adjustment), never plain cancel
```

Active = in {ASSIGNED, ACKNOWLEDGED, ARRIVED, STARTED, ENDING_SOON} — drives I5 partial unique.

## 4. Order / Payment / Refund

```
Order:      OPEN → IN_SERVICE → PENDING_CHECKOUT → PARTIALLY_PAID → PAID
            PAID → REFUND_PENDING → PARTIALLY_REFUNDED / REFUNDED
Payment:    CREATED → PENDING → CAPTURED ; PENDING → FAILED | CANCELLED
            CAPTURED → PARTIALLY_REFUNDED → REFUNDED
Refund:     REQUESTED → APPROVED → PROCESSING → COMPLETED | FAILED
```

Cash shortcut: `CREATED →(cashier confirm)→ CAPTURED` (records `cash_session_id`).
Terminal states are terminal: no transitions out of PAID/REFUNDED/FAILED without new rows.

## Error codes (initial registry — clients branch on these only)

`INVALID_STATE_TRANSITION`, `ROOM_NOT_ELIGIBLE`, `ROOM_OCCUPIED`, `TECHNICIAN_NOT_AVAILABLE`,
`TECHNICIAN_LOCKED`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `BALANCE_INSUFFICIENT`,
`APPROVAL_REQUIRED`, `PROVIDER_VERIFICATION_FAILED`, `UNAUTHORIZED_SCOPE`,
`VALIDATION_FAILED`, `NOT_FOUND`, `RATE_LIMITED`, `DEVICE_DISABLED`, `INTERNAL_ERROR`,
`SERVICE_UNAVAILABLE` (0005 devices: `ROOM_BOUND_TO_OTHER_DEVICE` 409 — room already
runs another ACTIVE device).
Registry lives in `packages/contracts/src/errors.ts`; adding a code = adding a row there +
doc entry, never ad-hoc strings.
