# Phase 10 — Android Room APK (spec §10) — BLOCKED: environment

- **Goal**: Room kiosk APK — Boot/Enrollment/Service/Bill flows, Lock Task kiosk, offline-tolerant sync client.
- **Status**: **BLOCKED (honest, environmental)** — NOT IMPLEMENTED, NOT VERIFIED.
- **Probe evidence (2026-10-29, this sandbox)**: no `java`/`javac`/`adb`/`gradle`/`sdkmanager` on PATH; `/usr/lib/jvm` absent; `ANDROID_HOME` unset; package manager egress blocked (apt); allowed egress hosts limited to GitHub/npm/PyPI — Android SDK artifacts (dl.google.com/android/repository) and Maven Central (repo1.maven.org) are outside the allowlist, so neither `sdkmanager` components nor Gradle/AndroidX dependencies are retrievable; RAM 3.9 GB / 2 cores (Gradle+AGP build would be marginal even with toolchains).
- **What stands in its place (verified server-side)**: Phase 09 device identity — enroll → §10.2 `LX-R-XXXXX` display code → console bind to 组织→门店→房间 → heartbeat returns binding truth (kiosk never trusts client roomId, §10.4). The kiosk's FIRST screen (§10.2 unbound panel) is fully served by `POST /v1/devices/enroll` + `GET /v1/devices/heartbeat`.
- **Unblock criteria**: sandbox with JDK 17+ (Temurin), Android SDK 34+, Maven Central + dl.google.com access (or preloaded caches), ≥8 GB RAM for CI builds. Then: assemble app module, device-owner/Lock Task spike, offline outbox against the Phase 19 EdgeSync contracts.
- **DoD**: NOT MET — recorded per Master Prompt stop-rule (genuine environment limit). No partial Kotlin sources are committed: unverifiable code would violate the no-fake-progress rule.
