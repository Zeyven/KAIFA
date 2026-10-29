# Phase 09 — Device Enrollment & Binding (spec §4.8 devices, §10.2/§10.4) + OpenAPI completion

- **Goal**: kiosk identity server-side — enroll → §10.2 device code → console bind (组织→门店→房间) → heartbeat; complete the §7.1 OpenAPI contract for all shipped routes.
- **Scope**: migration 0005 (devices + device.read/manage); DevicesModule {enroll (public, X-Org-Code, per-IP rate limit, audit), list (device.read, org-scoped incl. PENDING), heartbeat (public X-Device-Code → binding truth + last_seen; DISABLED/REVOKED → 403), bind/unbind/disable/revoke (device.manage; server cross-checks; one ACTIVE device per room → 409 ROOM_BOUND_TO_OTHER_DEVICE)}; new error codes ROOM_BOUND_TO_OTHER_DEVICE(409)/DEVICE_DISABLED(403) registered + doc'd; OpenAPI builder data-driven — 46 paths/47 ops.
- **Files**: packages/db/migrations/0005_devices.{up,down}.sql; apps/api/src/devices/*; contracts errors.ts + openapi.ts; docs/architecture/openapi.json (regenerated); state-machines.md registry; app.module.
- **Acceptance**: kiosk never sends roomId for identity (§10.4 — heartbeat reveals server truth only); binding console cannot attach cross-org/store/room; room runs ≤1 ACTIVE device (partial unique + friendly 409); rate-limited enrollment audited; OpenAPI covers every live route (openapi:check gate).
- **Tests**: devices.int 6/6; contracts 5/5 (structure + no-undefined); full verify EXIT 0 (unit 85, integration 88×10).
- **Security**: public endpoints rate-limited + audited; unknown device codes → security_events DEVICE_HEARTBEAT_UNKNOWN; revoke terminal; perms device.manage supervisor+ only (BUSINESS POLICY — REQUIRES PILOT VALIDATION); V1 device_code-as-credential upgrade path = §4.8 public_key (documented in service header).
- **Migration**: 0005 additive (down = drop table + grant rows). RC: phantom `rooms.deleted_at` column caused 500s → removed (RC#52).
- **Rollback**: down migration + revert module; clients unaffected (additive routes).
- **Risk**: device_code credential is short (displayed on kiosk) — acceptable V1 with rate limiting; per-device key is the documented upgrade.
- **DoD / Verification**: `npm run verify` EXIT 0; build-log #46–#49; root causes #52–#54.
