# Scheduling (排钟) — LanXu StoreOS V1

Normative: Master Prompt §6. Implementation target: `packages/domain/scheduling` (pure,
deterministic, explainable) + transactional assign in `apps/api` (Phase 05).

## Assignment modes

`ROTATION` · `REQUESTED` (点钟) · `RESERVATION` (预约) · `MANUAL` · `PRIORITY` ·
`COMPENSATION` (补钟)

## Pipeline

```
candidates (store, employed, in-shift, AVAILABLE, queue_enabled)
  → HARD filter: skill ✓, not locked/paused, no active session, no reservation conflict,
                 configured gender/area rules
  → SOFT score each survivor
  → pick max score (tie-break: queue position, then earliest eligible_since, then id)
  → explain: selected + per-candidate excluded reason / score breakdown
```

Any hard-constraint failure removes the candidate **before** scoring and must be reported in
`excluded[]` with a machine reason code (e.g. `FUTURE_RESERVATION_CONFLICT`,
`SKILL_MISSING`, `LOCKED`, `ACTIVE_SESSION`).

## Soft score (dev defaults)

```
score = 1000·queue_position_score + 100·idle_duration_score + 300·compensation_score
      + 30·skill_score + 20·preference_score
      − 500·future_reservation_penalty − 100·overtime_penalty
```

Weights live in `store_settings.scheduling_config` (JSONB), seeded from this table.
**BUSINESS POLICY — REQUIRES PILOT VALIDATION.** All weights must be adjustable per store; no
hardcoded weight may exist in code paths.

Reason codes for excluded[] (initial set):
`WRONG_STORE` · `NOT_EMPLOYED` · `OFF_SHIFT` · `NOT_AVAILABLE` · `QUEUE_DISABLED` ·
`SKILL_MISSING` · `LOCKED` · `ON_BREAK` · `ACTIVE_SESSION` · `FUTURE_RESERVATION_CONFLICT` ·
`GENDER_RULE` · `AREA_RULE`

## Atomic assign (Phase 05 acceptance — spec §6.4)

One transaction: `SELECT technician FOR UPDATE` → revalidate eligibility → assert no active
session (unique index backstop) → insert session/assignment → update technician state → update
queue entry → append service event → insert outbox event → COMMIT.
Two front desks assigning the same technician concurrently ⇒ **exactly one** succeeds; loser
gets 409/422 with a reason. Proven by a real-PG concurrency test (two pooled clients, barrier).

## Queue mechanics

- `technician_queue_entries`: partial UNIQUE on active entry per technician; `position_key`
  encodes order (lexicographic, e.g. zero-padded sequence or composite key — implementation
  detail frozen in Phase 05 ADR).
- Events appended to `technician_queue_events` (append-only: enqueue, reorder, skip, promote,
  compensation).
- `skip` (跳钟) and `reorder` are permission-gated commands with audit.

## Explainability contract

`POST /v1/scheduling/recommend` returns:

```json
{
  "selected": {"technicianNo": "082", "queuePosition": 1, "idleMinutes": 48, "score": 19432,
                "breakdown": {"queuePosition": 10000, "idleDuration": 2880, "skill": 30}},
  "alternates": [ {"technicianNo": "036", "queuePosition": 2, "score": 17210} ],
  "excluded": [ {"technicianNo": "091", "reason": "FUTURE_RESERVATION_CONFLICT"} ]
}
```

FrontDesk (spec §9.3) renders recommendation + exclusion reasons verbatim.

## Frozen vs. not

| Frozen (spec §6) | Not frozen (spec §21 — pilot data required) |
|---|---|
| modes, hard filter semantics, explainability shape | actual weights for each store |
| atomicity requirement, no blanket SERIALIZABLE | 点钟下牌/退钟补牌/加钟轮牌 behavior |
| config-driven constraints | 预约锁技师时长, 优轮/补钟 store variants |
