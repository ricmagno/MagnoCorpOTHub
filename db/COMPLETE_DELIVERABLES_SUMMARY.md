# Deliverables Summary

Package overview for the **tensor-aware, TEVE-compatible historian** for MagnoCorpOTHub.

---

## What This Package Contains

Four documents, all in `db/`:

| # | File | Purpose | Audience |
|---|------|---------|----------|
| 1 | `00_START_HERE_EXECUTION_SUMMARY.md` | Orientation, stage gates, troubleshooting | Everyone — read first |
| 2 | `TENSOR_HISTORIAN_IMPLEMENTATION_PLAN_V2.md` | The staged plan: code, verification commands, success criteria per stage | Engineers executing the work |
| 3 | `COMPLETE_DELIVERABLES_SUMMARY.md` | This file — package index and decision record | Everyone |
| 4 | `new_feature.md` | Historical: the critical review of the v1 plan and the rationale for every v2 fix | Reviewers, future maintainers |

**Note**: earlier drafts referenced additional documents (architecture deep-dive, quick reference, executive summary, README index). Those were never added to this repository and the v1 plan they described has been removed. The v2 plan is self-contained; treat any reference to those files as stale.

---

## How to Use This Package

### You're deciding whether to proceed
1. Read `00_START_HERE_EXECUTION_SUMMARY.md` — What Is Being Built + Key Decisions.
2. Skim the plan's stage gates and Remaining Open Items.
3. Read `new_feature.md` to understand the quality history (v1 shipped with day-1-breaking bugs; v2 corrected 14 of them).

### You're the engineer executing it
1. Read `00_START_HERE_EXECUTION_SUMMARY.md` end to end.
2. Open `TENSOR_HISTORIAN_IMPLEMENTATION_PLAN_V2.md`, complete the Pre-Flight Checklist.
3. Execute stages 1 → 5 in order. Every stage has a gate; do not skip gates.

### You're reviewing the design
- The plan's "What Changed and Why" table maps each v1 defect to its v2 fix.
- `new_feature.md` gives the narrative behind those fixes.

---

## Key Decisions (Corrected Record)

| Decision | Choice | Alternative rejected | Why |
|----------|--------|----------------------|-----|
| Database | PostgreSQL via `timescale/timescaledb-ha:pg16` (TimescaleDB **and** pgvector in one image) | Plain pgvector image; separate Qdrant | Hypertables need TimescaleDB; single DB gives ACID + SQL joins with vectors |
| Embeddings | CLIP-ViT-Base-Patch16, **512-D**, via `@xenova/transformers` | Hand-rolled ONNX; custom model | Correct preprocessing built in, auto-downloads model; 512-D is the actual projected output of this model |
| Vector index | **HNSW** | ivfflat | Works on an empty table (no training step), better recall |
| Async processing | Bull Queue, singleton, **concurrency 4 per worker** | Spark/Flink/Airflow; 32 in-process workers | Workload is small; embedding is CPU-bound — high in-process concurrency just thrashes. Scale with worker replicas |
| Object storage | MinIO (S3 API) | Data lake | Self-hosted, simple, fits the deployment model |
| GraphQL | `@apollo/server` v4 + `@graphql-tools/schema` | `express-graphql`, `apollo-server-express` | Both alternatives deprecated/broken in the v1 plan |
| Compute | CPU only | GPU workers | ~400 screenshots/day ≈ 15 min CPU compute/day; GPU unjustified at current volume |
| Compatibility | TEVE bridge layer (`/api/teve/*` + `teve_pointsdata` view) | New API only | Existing clients work unchanged; parallel operation before cutover |

---

## Staged Plan Overview

```
Stage 1: Foundation & Database
  ├─ Docker Compose (Postgres/TimescaleDB+pgvector, Redis, MinIO)
  ├─ Schema: scada_systems, screenshots (vector(512), HNSW),
  │  metrics (hypertable, nullable screenshot_id), relationships, anomalies
  ├─ TEVE compatibility view
  └─ Gate: verify script — extensions, dim=512, hypertable, seed data

Stage 2: Embedding Pipeline
  ├─ CLIP embedder (@xenova/transformers)
  ├─ S3 upload/download (the v1 plan never uploaded)
  ├─ Singleton Bull Queue + worker (concurrency 4)
  ├─ Screenshot capture (Puppeteer)
  └─ Gate: POST screenshot → processed row with 512-D embedding;
     similarity search returns ordered results

Stage 3: TEVE Compatibility
  ├─ /api/teve/tags, /api/teve/data, /api/teve/pointsdata
  └─ Gate: replay real client queries, row-by-row diff —
     100% match or documented, approved deviations

Stage 4: GraphQL & UI
  ├─ Apollo Server 4 schema + resolvers
  └─ Gate: verification queries pass

Stage 5: Production
  ├─ Kubernetes: API and embedding worker as separate Deployments
  ├─ Monitoring, alerting, security hardening
  └─ Gate: production readiness review
```

Progression is gated on verification results, not on a schedule.

---

## Pre-Execution Checklist

### Environment
- [ ] Node.js 18+ (`node -v`)
- [ ] Docker & Docker Compose (`docker --version`)
- [ ] 20+ GB free disk (CLIP model ~600 MB, Docker images ~3 GB)
- [ ] Feature branch created: `feature/tensor-historian`

### Knowledge
- [ ] Executing engineers have read the Start Here doc and the plan
- [ ] Team understands the TEVE compatibility requirement and its Stage 3 gate

### Infrastructure
- [ ] Existing TEVE database reachable (needed for Stage 3 replay testing)
- [ ] Sample SCADA screenshots / reachable HMI URLs for capture testing
- [ ] Confirmed whether any client **writes** via TEVE interfaces (unscoped if so — resolve before Stage 3)

---

## Known Limitations / Open Items

- **OCR metric extraction**: explicitly out of MVP scope. Add only if metric values must be read from pixels rather than arriving via TEVE/SQL.
- **Metric and anomaly embeddings**: removed from the schema until something actually produces them.
- **TEVE write-path**: plan covers reads only.
- **Queue dashboard**: monitor via Bull events/logs for MVP; add a dashboard later if operationally needed.

---

## Next Action

Read `00_START_HERE_EXECUTION_SUMMARY.md`, then open the plan and run the Pre-Flight Checklist.
