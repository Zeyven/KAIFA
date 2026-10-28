# infra/

Environment definition per spec §3. Status markers matter here — never assume a
file below runs: capability is recorded in `PLANS.md` blockers and each phase's
Verification Result.

| Path | Purpose | Status in this repo |
|---|---|---|
| `docker/docker-compose.dev.yml` | PG 18 + Redis + api + web dev stack | authored — NOT VERIFIED (no Docker in build env) |
| `docker/Dockerfile.api` / `Dockerfile.web` | multi-stage images | authored — NOT VERIFIED |
| `cloud/` | managed PG backup/PITR + deploy manifests | planned (Phase 26/28) |
| `edge/` | store edge compose (Node+PG+Redis) | planned (Phase 19) |
| `monitoring/` | metrics/alerts definitions (OTel, outbox lag, sync lag) | planned (Phase 18/22) |
| `backup/` | backup scripts + restore drill tooling | planned (Phase 26) |
