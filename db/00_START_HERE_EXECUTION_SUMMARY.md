# Tensor Historian: Execution Summary

Start here. This document orients you, then hands off to the implementation plan.

## What Is Being Built

A tensor-aware, TEVE-compatible historian service:

- **PostgreSQL** on `timescale/timescaledb-ha:pg16` — ships with **both** TimescaleDB (hypertables, compression, `time_bucket`) and **pgvector** (512-D embeddings, HNSW index)
- **CLIP image embeddings** via `@xenova/transformers` (`Xenova/clip-vit-base-patch16`, 512-D, CPU)
- **Bull Queue** (Redis) for async embedding jobs — singleton queue, concurrency 4 per worker
- **MinIO** (S3-compatible) for screenshot storage
- **REST** endpoints (capture, similarity search, TEVE compatibility) + **GraphQL** (Apollo Server 4)

## Document Map

| File | Purpose |
|------|---------|
| `00_START_HERE_EXECUTION_SUMMARY.md` | This file — orientation and execution guide |
| `TENSOR_HISTORIAN_IMPLEMENTATION_PLAN_V2.md` | **The plan.** Staged, step-by-step, with code, verification commands, and success criteria |
| `COMPLETE_DELIVERABLES_SUMMARY.md` | Package overview, key decisions, pre-execution checklist |
| `new_feature.md` | Historical record: the v1 review that produced v2 (why each fix was made) |

The v1 plan has been removed; v2 is the only plan. Do not resurrect v1 material — it contained day-1-breaking bugs (see `new_feature.md`).

## How to Execute

Work through the stages **in order**. Each stage has explicit success criteria in the plan; do not start a stage until the previous stage's criteria pass.

### Stage 0 — Pre-flight
Run the Pre-Flight Checklist at the top of the plan (Node 18+, Docker, disk space, feature branch, TEVE database reachable for Stage 3 testing).

### Stage 1 — Foundation & Database
Follow Plan §1.1–1.6: project structure, dependencies, config, Docker Compose, `init.sql`, verify script.

```bash
npm run historian:up
npm run historian:verify
```

**Gate**: verify script passes all four checks — extensions (`timescaledb` + `vector`), embedding dimension = 512, `metrics` is a hypertable, seed SCADA systems present.

### Stage 2 — Embedding Pipeline
Follow Plan §2.1–2.5: embedder, S3 object store, singleton queue, capture service, REST routes.

**Gate**: POST a screenshot → row reaches `processing_status='processed'` with a 512-D embedding; the similar-search endpoint returns ordered results.

### Stage 3 — TEVE: Tensor Embedding Vector Engine (redefined 2026-07-08)
TEVE is **our own embedding engine**, not an external legacy system (none exists — earlier
drafts assumed one; investigation found no config, connection, or client anywhere). Follow
Plan §3: engine module (`src/historian/teve/`), three modalities — CLIP text→screenshot
search, `teve-ts-stat-v1` time-series window embeddings, anomaly signature embeddings —
plus migrations (`npm run historian:migrate`), backfill, worker sweep, REST + GraphQL.

**Gate**: `npm run historian:eval` — offline retrieval-quality thresholds (image P@3 ≥ 0.8,
text top-1 ≥ 2/3, time-series P@3 ≥ 0.9). Replaces the retired replay-and-diff gate.

### Stage 4 — GraphQL & UI
Follow Plan §4.1–4.2: Apollo Server 4 schema + resolvers, service entry point.

**Gate**: GraphQL queries return correct data (see the plan's verification commands).

### Stage 5 — Production
Follow Plan Phase 5: Kubernetes deployment with the embedding worker as a **separate Deployment** from the API (API pods load no model; worker pods each load the ~600 MB CLIP model, concurrency 4), monitoring, security hardening.

**Gate**: production readiness review passed.

## Stage Tracking

```
[x] Stage 0: Pre-flight checklist complete
[x] Stage 1: Database foundation — verify script green (extensions, dim=512, hypertable, seed data)
[x] Stage 2: Embedding pipeline — end-to-end screenshot → embedding, verified locally
[x] Stage 3: TEVE (Tensor Embedding Vector Engine) — redefined 2026-07-08 as our own engine
      (no external TEVE system exists). Implemented: text→screenshot search, time-series
      window embeddings (teve-ts-stat-v1), anomaly signatures, migrations, backfill, worker
      sweep, REST + GraphQL. Gate PASSED: historian:eval → ts P@3 0.967, image P@3 1.000,
      text top-1 100%; 23 unit/property tests green; live end-to-end verified against seeded
      sine/ramp tags (correct ranking) and real captured screenshots. Production images
      rebuilt with TEVE (historian-api:teve 507MB, historian-worker:teve 348MB) and the API
      image's /teve/search verified working with HISTORIAN_ALLOW_REMOTE_MODELS=false —
      text encoder loads from the baked cache, air-gap safe
[x] Stage 4: GraphQL & UI — resolvers verified locally (screenshot/screenshots/
      similarScreenshots/searchScreenshots/metrics/similarMetricWindows/anomalies/
      similarAnomalies). React UI built 2026-07-09: new "Insights" tab in Dashboard.tsx
      (client/src/components/insights/) with three panels — screenshot text search
      (+ click-through similar), metric window similarity lookup, anomaly browser with
      similar-incident lookup.

      Revised same day: TEVE is a genuinely separate, optional database/service in its
      own container(s), not something to assume is always present — reworked from a
      client-side dev-proxy hack into a proper backend-owned integration:
        - src/services/teveConfigService.ts — {enabled, baseUrl} in auth.db's
          site_settings table (mirrors brandingService.ts), off by default
        - src/routes/teveConfig.ts — GET (authenticated)/PUT (admin)/POST /test
          (admin, tests a candidate URL before saving, mirrors databaseConfig.ts)
        - src/routes/teveProxy.ts — the main backend proxies /api/teve/*,
          /api/historian/*, /api/teve-graphql to the admin-configured baseUrl using
          native fetch (no new dependency); 503s cleanly when disabled/unconfigured.
          The browser never talks to TEVE directly, in dev or production, regardless
          of whether an ingress unifies hosts — replaces the earlier
          client/src/setupProxy.js approach (deleted)
        - client/src/components/configuration/TeveConfiguration.tsx — new admin tab
          ("Tensor Historian") in ConfigurationManagement.tsx: enable toggle, base URL,
          Test Connection, Save — same pattern as Branding/Identity Provider tabs
        - client/src/hooks/useTeveConfig.ts — Dashboard.tsx only shows the Insights
          tab when TEVE is actually enabled; fails closed (hidden) on any error
        - Real gap fixed along the way: GET /api/historian/screenshots/:id/image
          requires auth (like everything else proxied), but <img src> can't send an
          Authorization header — switched to fetch-as-blob via
          client/src/hooks/useScreenshotImage.ts rather than making screenshots
          publicly fetchable by URL

      Verified: tsc clean (both apps), jest 23/23, eval gate still passing. Full proxy
      chain re-verified end-to-end via curl through the REAL flow this time — logged in
      as admin, confirmed GET /api/teve-config defaults to disabled, confirmed the proxy
      503s while disabled, enabled it via PUT, confirmed GraphQL/REST-search/image-proxy
      all work correctly through the main backend (port 3001) AND through the client dev
      server (port 3000) unchanged, confirmed disabling it immediately 503s the proxy
      again, confirmed no-token requests 401. Bundle inspection confirmed the new code
      compiled in with no errors. NOT verified: actual browser rendering/interaction —
      no browser automation available in this environment, so the visual layout,
      click-through flows, and console-error-free rendering are unconfirmed.

      Positioning correction (2026-07-09): Tensor Historian is meant as a genuine
      alternative historian, not merely an Insights-tab add-on riding on AVEVA Historian.
      Closed the two gaps that made that claim false:
        - src/historian/routes/teve-compatibility.ts — new POST /api/teve/ingest
          (batch metric write, upserts historian.scada_systems + historian.metrics).
          Tensor Historian's own DB/credentials stay private to the historian service —
          nothing outside it writes to Postgres directly.
        - src/services/opcuaService.ts — real bug found and fixed while wiring the
          ingestion service: subscriptions and connect/reconnect callbacks were single
          slots, silently overwritten by a second consumer. A second consumer calling
          createSubscription() would have TERMINATED alertEvalService's live alarm
          monitoring the moment Tensor Historian ingestion started. Refactored to keyed
          subscriptions (Map<string, ClientSubscription>) and callback arrays;
          alertEvalService.ts updated to pass its 'alerts' key at all 6 call sites.
          opcuaService_retry.test.ts's mock was missing an .on() method (masked by the
          old conditional-attach code path) — fixed as part of the same change.
        - src/services/teveTagConfigService.ts + src/routes/teveTagConfig.ts — admin-
          configured "tags to historize" list (separate from alert-monitored tags —
          overlapping but independent concerns), CRUD at /api/teve-tag-config.
        - src/services/tensorHistorianIngestService.ts — owns its own OPC UA
          subscription ('tensor-historian' key), batches value changes, flushes to
          POST /api/teve/ingest every 5s. Wired into server.ts startup/shutdown
          alongside alertEvalService.
        - client/src/components/configuration/TeveHistorizeTags.tsx — new tag-list
          management UI (add/remove by node ID), rendered inside the Tensor Historian
          config tab below the connection settings.
        - Corrected misleading copy in TeveConfiguration.tsx ("not a replacement for
          it" → usable standalone or alongside AVEVA Historian).

      Verified live: POST /api/teve-tag-config CRUD round-trips correctly; POST
      /api/teve/ingest inserts a batch, upserts the scada_systems row, and the data is
      immediately readable back through the pre-existing GET /api/teve/data route
      (proves the full loop, not just an isolated write); validation 400s on missing
      scadaSystem/empty batch; ON CONFLICT upsert confirmed (re-ingesting the same
      timestamp updates the value rather than erroring or duplicating). tsc clean both
      apps; full Jest suite green (not just the teve/opcua subset) after the
      opcuaService.ts refactor; eval gate still passing. NOT done: report/dashboard
      integration (dataRetrieval.ts / reportGeneration.ts still only know about the
      AVEVA Historian — deferred per the user's explicit priority call to close the
      ingestion gap first) and no OPC UA browse-tree tag picker (tag list is manual
      node-ID entry for now, not a guided picker off the existing /api/opcua/browse).
[~] Stage 5: Production — Kubernetes manifests + Dockerfile.historian built and verified against
      a live cluster (kind); CI extended to build/push both images. Monitoring kept to liveness/
      readiness probes + structured logs (deliberately, per the plan's own volume estimate — not
      a gap). NOT done: deeper security hardening pass, images never actually published (CI job
      untested against a real GHCR push — only validated locally)
```

Local dev verification was run against Docker Compose services (`timescale/timescaledb-ha:pg16`,
`redis:7-alpine`, `minio/minio`) on 2026-07-07, using `HMI-01`/`example.com` and `HMI-02`/`example.org`
as capture targets and hand-seeded `historian.metrics` rows — not real SCADA/HMI data. Before trusting
this as done: run the actual Stage 3 compatibility gate against a real TEVE system, and build the
Stage 4 React UI (dashboard integration, visualization) referenced in the plan's phase description
but not covered by the GraphQL API alone.

Stage 5 K8s validation (2026-07-08): `historian-api`/`historian-worker` images built successfully
via `Dockerfile.historian` (both targets). All manifests in `Kubernetes/historian-*.yaml` passed
`kubectl apply --dry-run=server`, and Postgres/Redis/MinIO were verified actually running and
healthy in a local `kind` cluster — including a real bug found and fixed: the postgres Deployment
needed an initContainer to chown its hostPath volume (`fsGroup` doesn't reliably chown hostPath
volumes), documented in `historian-postgres-deployment.yaml`. Confirmed in the live cluster:
extensions installed (timescaledb + vector), `metrics` is a hypertable, embedding dim = 512, all 4
seed SCADA systems present — the same four checks as Stage 1's original gate, now passing through
actual K8s manifests rather than docker-compose. `.github/workflows/docker-publish.yml` extended
with a `build-and-push-historian` matrix job (api/worker) — not yet exercised by a real tagged
release, so treat as unverified until the first real CI run.

Commit at the end of each stage on the `feature/tensor-historian` branch.

## Key Decisions (Why This Stack)

- **Bull Queue, not Spark/Flink** — the workload (~400 screenshots/day) is far too small for distributed processing. Concurrency 4 per worker; scale by adding worker replicas, not by raising in-process concurrency.
- **pgvector in PostgreSQL, not a separate vector DB** — single database, ACID, SQL joins with vectors; comfortably handles this volume.
- **`timescale/timescaledb-ha` image** — the only image in play that ships TimescaleDB *and* pgvector together. A plain pgvector image has no hypertable support and fails Stage 1.
- **`@xenova/transformers`, not hand-rolled ONNX** — correct CLIP preprocessing built in, auto-downloads the model, runs on CPU. No GPU needed at current volume (~15 min of compute/day).
- ~~**TEVE bridge, not a new API only** — existing clients work unchanged; parallel operation before any cutover.~~ Retired 2026-07-08: TEVE is our own engine, not a bridge to a legacy system. The `/api/teve/tags|data|pointsdata` routes remain as the engine's time-series read API.

## ~~Cutover Strategy (After Stage 3 Gate Passes)~~ — RETIRED 2026-07-08

This section presumed an external legacy TEVE system to migrate away from. No such system
exists (see Stage 3); there is nothing to cut over from. Kept for historical context only:

1. ~~**Parallel operation** — historian captures and stores alongside TEVE as primary; cross-validate data continuously.~~
2. ~~**Gradual cutover** — new dashboards read from the historian, legacy dashboards stay on TEVE, routed by feature flag.~~
3. ~~**TEVE as backup** — historian becomes primary; TEVE archived read-only for disaster recovery.~~

## Common Issues & Solutions

### "function create_hypertable does not exist" / "extension timescaledb not found"
**Cause**: wrong Docker image — a plain PostgreSQL or pgvector-only image.
**Fix**: use `timescale/timescaledb-ha:pg16` as in the plan's Docker Compose. It includes both TimescaleDB and pgvector.

### "extension vector not found"
Same cause and fix as above — both extensions ship in `timescale/timescaledb-ha`.

### init.sql changes not taking effect
**Cause**: `init.sql` only runs on a **fresh** Postgres volume.
**Fix**: `npm run historian:down && docker compose -f docker-compose.historian.yml down -v`, then `npm run historian:up`.

### "expected 512 dimensions, not N"
**Cause**: schema/model mismatch. `Xenova/clip-vit-base-patch16` outputs **512-D** projected image embeddings (768 is ViT-Large or the unprojected hidden state).
**Fix**: keep `vector(512)` in the schema and the default model in config. The embedder validates dimension at runtime and fails loudly on mismatch.

### Embedding too slow
**Cause**: expectations calibrated to GPU. Transformers.js is CPU (~1–2 s/image).
**Fix**: at ~400 screenshots/day this is ~15 minutes of compute daily — batch via the queue and let it drain. Only if volume grows ~50x, add worker replicas or move inference to a Python sidecar / onnxruntime CUDA.

### Vector similarity search slow
**Cause**: HNSW index missing (it is created empty-safe in `init.sql` — no training step needed, unlike ivfflat).
**Fix**: confirm `idx_screenshot_embedding` exists (`\d historian.screenshots`); check the query uses the `<=>` cosine-distance operator and `ORDER BY distance ASC` as in the plan.

### Bull Queue workers not processing
**Cause**: Redis down or unreachable.
**Fix**: `redis-cli ping` → expect `PONG`; check `docker compose -f docker-compose.historian.yml ps` and worker logs.

### Aggregated `/api/teve/data` results differ after compression kicks in
**Cause**: timestamp rounding/compression differences.
**Fix**: temporarily disable compression on `historian.metrics` for validation, re-enable after:
```sql
ALTER TABLE historian.metrics SET (timescaledb.compress = off);
-- validate, then:
ALTER TABLE historian.metrics SET (timescaledb.compress = on);
```

## Open Items (Unresolved by Design)

Carried from the plan — decide these before the stage that needs them:

- **OCR metric extraction** — out of MVP scope; only add if metrics genuinely must come from screenshot pixels rather than SQL ingestion.
- ~~**Metric/anomaly embeddings** — removed until a model exists that produces them.~~ Resolved 2026-07-08: `teve-ts-stat-v1` produces both (Stage 3).
- ~~**TEVE write-path** — the plan covers reads only; verify no client writes through TEVE interfaces before Stage 3.~~ Resolved N/A 2026-07-08: no external TEVE clients exist.
- **Anomaly detection** — anomaly *signature embeddings* exist, but nothing writes anomaly rows yet; a detector is future scope.

## Next Step

Open `TENSOR_HISTORIAN_IMPLEMENTATION_PLAN_V2.md`, run the Pre-Flight Checklist, then start Stage 1.
