# Device Security (Room Android Kiosk) — LanXu StoreOS V1

Normative: Master Prompt §10. Phases 09–10 implement; verification env (JDK/Android SDK) is
absent here — see PLANS.md blockers.

## Posture

Room devices run as **Dedicated / Fully Managed** devices. Lock Task mode pins the UX to the
allowlisted kiosk app; only DPC-allowlisted apps can enter Lock Task (Android docs — spec
Appendix B). Kiosk escape is treated as a High finding (spec §22.2).

## Requirements (acceptance checklist)

1. **Enrollment**: fresh install shows `设备未绑定` screen with device code (`LX-R-<roomcode>-<rand>`).
   Admin binds 组织 → 门店 → 房间 via backend (approval step optional per store config).
   Unbound device can ONLY call the enrollment endpoints — never room business APIs (Phase 09
   gate: "未绑定设备不可访问房间业务").
2. **Credential binding**: device holds a store/room-scoped credential (rotating
   `credential_version`). Server resolves room FROM the credential — a client-supplied
   `roomId` is ignored for device traffic (I27). One active device per room (unique index).
3. **No secrets at rest in APK**: no DB passwords, no payment keys, no server secrets. App
   storage holds only session tokens + non-sensitive cache.
4. **Lifecycle**: auto-start on boot, crash recovery, survives network loss (shows
   `Device Offline` state, keeps rendering last known service timer, queues actions via Edge).
5. **Privacy reset**: when room returns to `VACANT_CLEAN`, wipe previous guest's temp state
   (names, requests, bill views) from app storage and any screen cache.
6. **Escape testing**: documented kiosk-escape attempts (home key, recents, notification,
   ADB, app switch) must all fail or re-enter the kiosk; test evidence stored in
   `harness/phases/10-*/`.

## Threat notes (from threat-model.md)

- T7 Edge/device tampering, T8 guest-driven kiosk escape.
- Device traffic authenticates via device credential flow (mutual auth semantics: signed
  challenge with device keypair, `devices.public_key` recorded at enrollment).
- Compromised device = room-scoped blast radius only; it can never mint org-wide effects.

## Rollback

Device unbind is an audited admin action; unbinding immediately revokes credential version
(`credential_version` bump invalidates outstanding tokens).
