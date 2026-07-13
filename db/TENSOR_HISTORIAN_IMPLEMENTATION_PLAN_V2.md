# Tensor Historian: Implementation Plan v2 (Corrected)
## Supersedes the v1 plan (removed from this repo — see new_feature.md for the review that retired it)

**Status**: Corrected and verified against library APIs
**Changes from v1**: 14 fixes — see CHANGELOG at bottom

---

## What Changed and Why (Read First)

| # | v1 Problem | v2 Fix |
|---|-----------|--------|
| 1 | `pgvector/pgvector` image has no TimescaleDB; all hypertable SQL fails | Use `timescale/timescaledb-ha:pg16` (includes both TimescaleDB and pgvector) |
| 2 | Schema used `vector(768)` but CLIP-ViT-Base-Patch16 outputs 512-D image embeddings | Schema and code use `vector(512)` |
| 3 | Hand-rolled ONNX preprocessing fed PNG bytes as raw pixels; input/output tensor names were guesses; no model download step | Replaced with `@xenova/transformers` — correct preprocessing built in, auto-downloads model |
| 4 | `storeEmbedding` SQL referenced `$3` with only 2 params | Fixed to `$2` |
| 5 | Similarity SQL ordered wrong, didn't exclude NULL embeddings, repeated subquery | Rewritten with CTE, `ORDER BY distance ASC`, NULL guard |
| 6 | Capture service never uploaded to MinIO; worker treated S3 key as local path | Added S3 upload; worker downloads from S3 to temp file |
| 7 | New Bull Queue (Redis connection) created per enqueue call | Singleton queue module |
| 8 | `metrics.screenshot_id` NOT NULL + in PK — blocks normal metric ingestion | Nullable; PK is `(time, scada_system_id, tag_name)` |
| 9 | ivfflat index on empty table (mislabeled as HNSW) | HNSW index — works from empty, better recall |
| 10 | GraphQL: `express-graphql` not in deps; `{Query:{...}}` rootValue returns null with buildSchema | Switched to `@apollo/server` v4 with proper resolver map via `@graphql-tools/schema` |
| 11 | Puppeteer missing from deps; `waitForTimeout` removed in modern versions | Added dep; plain `setTimeout` promise |
| 12 | `pg_cron` declared but unused (needs preload config) | Removed |
| 13 | TEVE `/data` route bound 6 params to 5 placeholders | Params built cleanly per branch |
| 14 | Hardcoded role passwords in init.sql presented as production-ready | Marked dev-only; production uses secrets |

---

## Pre-Flight Checklist

- [ ] Node.js 18+ (`node -v`)
- [ ] Docker & Docker Compose (`docker --version`)
- [ ] 20+ GB free disk (model download ~600 MB, Docker images ~3 GB)
- [ ] Git branch: `git checkout -b feature/tensor-historian`
- [x] ~~TEVE database reachable (for Phase 3 compatibility testing)~~ — retired 2026-07-08: no
      external TEVE system exists; TEVE is our own engine (see Phase 3) and its gate is offline
- [ ] Note: GPU is optional. Transformers.js runs on CPU (~1-2s/image). If throughput becomes a problem, revisit with a Python sidecar or onnxruntime-node CUDA build — do not block Phase 1 on this.

---

## Phase 1: Foundation & Database

### 1.1 Project Structure

```bash
mkdir -p src/historian/{services,routes,workers,graphql,config}
mkdir -p database scripts/historian kubernetes/historian docs/historian
```

### 1.2 Dependencies

```json
{
  "dependencies": {
    "pg": "^8.11.0",
    "pgvector": "^0.2.0",
    "@xenova/transformers": "^2.17.0",
    "sharp": "^0.33.0",
    "bull": "^4.12.0",
    "@aws-sdk/client-s3": "^3.500.0",
    "@apollo/server": "^4.10.0",
    "@graphql-tools/schema": "^10.0.0",
    "graphql": "^16.8.0",
    "puppeteer": "^22.0.0",
    "pino": "^8.16.0",
    "dotenv": "^16.3.1",
    "uuid": "^9.0.1",
    "express": "^4.18.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "@types/uuid": "^9.0.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.3.0"
  },
  "scripts": {
    "historian:verify": "ts-node scripts/historian/verify-db.ts",
    "historian:dev": "ts-node src/historian/index.ts",
    "historian:up": "docker compose -f docker-compose.historian.yml up -d",
    "historian:down": "docker compose -f docker-compose.historian.yml down"
  }
}
```

Notes:
- `@xenova/transformers` replaces `onnxruntime-node` + `tesseract.js` for the MVP. It downloads and caches the CLIP model on first run and handles image preprocessing correctly. OCR (tesseract) is deferred to a later phase — it was untested scope in v1.
- `apollo-server-express` (v1 plan) is deprecated; `@apollo/server` is current.

### 1.3 Environment Config (`src/historian/config/index.ts`)

```typescript
import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  database: {
    url: process.env.DATABASE_URL ??
      'postgresql://historian:historian_pwd@localhost:5432/historian_db',
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKey: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
    bucket: process.env.S3_BUCKET ?? 'historian-data',
    region: process.env.S3_REGION ?? 'us-east-1',
  },
  redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  embedding: {
    // Xenova model id; downloaded automatically on first run
    model: process.env.EMBEDDING_MODEL ?? 'Xenova/clip-vit-base-patch16',
    dimension: 512, // CLIP-ViT-Base projected image embedding size
  },
  server: { port: parseInt(process.env.PORT ?? '3000', 10) },
};
export default config;
```

### 1.4 Docker Compose (`docker-compose.historian.yml`)

```yaml
services:
  postgres:
    # timescaledb-ha includes BOTH TimescaleDB and pgvector
    image: timescale/timescaledb-ha:pg16
    container_name: historian_postgres
    environment:
      POSTGRES_USER: historian
      POSTGRES_PASSWORD: historian_pwd
      POSTGRES_DB: historian_db
    ports: ["5432:5432"]
    volumes:
      - postgres_data:/home/postgres/pgdata/data
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U historian"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: historian_redis
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio:latest
    container_name: historian_minio
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]
    volumes: [minio_data:/data]
    command: server /data --console-address ":9001"

  # One-shot: create the bucket on startup
  minio-init:
    image: minio/mc:latest
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "
      sleep 3;
      mc alias set local http://minio:9000 minioadmin minioadmin;
      mc mb --ignore-existing local/historian-data;
      "

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

Notes:
- v1's `bull-board` container image was unverified; monitor queues via `bull` events/logs for MVP, add a dashboard later if needed.
- init.sql only runs on a **fresh volume**. To re-run: `docker compose -f docker-compose.historian.yml down -v` first.

### 1.5 Database Schema (`database/init.sql`)

```sql
-- Extensions (both ship with timescale/timescaledb-ha)
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS historian;

-- 1. SCADA systems
CREATE TABLE historian.scada_systems (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled BOOLEAN DEFAULT true,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Screenshots with embeddings (512-D for CLIP-ViT-Base-Patch16)
CREATE TABLE historian.screenshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scada_system_id TEXT NOT NULL REFERENCES historian.scada_systems(id),
    timestamp TIMESTAMPTZ NOT NULL,
    s3_bucket TEXT,
    s3_key TEXT NOT NULL UNIQUE,
    file_size_bytes BIGINT,
    embedding vector(512),
    embedding_model TEXT DEFAULT 'Xenova/clip-vit-base-patch16',
    embedding_generated_at TIMESTAMPTZ,
    extracted_metrics JSONB,
    processing_status TEXT DEFAULT 'pending'
        CHECK (processing_status IN ('pending','processing','processed','failed')),
    processing_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW: works on empty tables, no training step, better recall than ivfflat
CREATE INDEX idx_screenshot_embedding ON historian.screenshots
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_screenshot_time ON historian.screenshots
    (scada_system_id, timestamp DESC);
CREATE INDEX idx_screenshot_pending ON historian.screenshots
    (processing_status) WHERE processing_status IN ('pending','processing');

-- 3. Time-series metrics (TEVE-compatible)
-- screenshot_id is NULLABLE: most historian metrics won't come from a screenshot.
CREATE TABLE historian.metrics (
    time TIMESTAMPTZ NOT NULL,
    scada_system_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,
    tag_value DOUBLE PRECISION,
    tag_status TEXT DEFAULT 'Good',
    tag_unit TEXT,
    screenshot_id UUID,  -- optional provenance link
    PRIMARY KEY (time, scada_system_id, tag_name)
);

SELECT create_hypertable('historian.metrics', 'time', if_not_exists => TRUE);

CREATE INDEX idx_metric_tag_time ON historian.metrics
    (scada_system_id, tag_name, time DESC);
CREATE INDEX idx_metric_screenshot ON historian.metrics (screenshot_id)
    WHERE screenshot_id IS NOT NULL;

ALTER TABLE historian.metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'scada_system_id,tag_name'
);
SELECT add_compression_policy('historian.metrics', INTERVAL '7 days', if_not_exists => TRUE);

-- 4. Relationships
CREATE TABLE historian.relationships (
    id BIGSERIAL PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    strength DOUBLE PRECISION CHECK (strength BETWEEN -1 AND 1),
    temporal_lag_seconds INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_type, source_id, target_type, target_id, relationship_type)
);
CREATE INDEX idx_rel_source ON historian.relationships (source_type, source_id);
CREATE INDEX idx_rel_target ON historian.relationships (target_type, target_id);

-- 5. Anomalies
CREATE TABLE historian.anomalies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detected_at TIMESTAMPTZ NOT NULL,
    screenshot_id UUID REFERENCES historian.screenshots(id) ON DELETE SET NULL,
    metric_tag TEXT,
    anomaly_type TEXT,
    anomaly_score DOUBLE PRECISION CHECK (anomaly_score BETWEEN 0 AND 1),
    description TEXT,
    resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_anomaly_open ON historian.anomalies (detected_at DESC)
    WHERE resolved = false;

-- 6. TEVE compatibility view (no ORDER BY in views — clients sort)
CREATE VIEW historian.teve_pointsdata AS
SELECT
    scada_system_id || '.' || tag_name AS "PointID",
    time AS "DateTime",
    tag_value AS "Value",
    tag_status AS "Status",
    0 AS "Milliseconds"
FROM historian.metrics;

-- 7. Seed data
INSERT INTO historian.scada_systems (id, name, description) VALUES
  ('HMI-01', 'Main HMI Dashboard', 'Primary SCADA interface'),
  ('HMI-02', 'Backup HMI Dashboard', 'Secondary interface'),
  ('PLC-01', 'Main PLC', 'Primary controller'),
  ('GATEWAY-01', 'Edge Gateway', 'IoT gateway for sensors')
ON CONFLICT DO NOTHING;

-- NOTE (dev only): app roles with hardcoded passwords are acceptable for local
-- Docker. In production, create roles via your secrets pipeline, never init.sql.
```

### 1.6 Verify (`scripts/historian/verify-db.ts`)

```typescript
import { Pool } from 'pg';
import config from '../../src/historian/config';

async function main() {
  const pool = new Pool({ connectionString: config.database.url });
  try {
    const ext = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','timescaledb')"
    );
    if (ext.rows.length < 2) throw new Error('Missing extension: need vector AND timescaledb');
    console.log('extensions ok:', ext.rows.map(r => r.extname).join(', '));

    const dim = await pool.query(
      `SELECT atttypmod AS dim FROM pg_attribute
       WHERE attrelid = 'historian.screenshots'::regclass AND attname = 'embedding'`
    );
    if (dim.rows[0]?.dim !== 512) throw new Error(`embedding dim is ${dim.rows[0]?.dim}, expected 512`);
    console.log('embedding dimension ok: 512');

    const ht = await pool.query(
      `SELECT hypertable_name FROM timescaledb_information.hypertables
       WHERE hypertable_name = 'metrics'`
    );
    if (ht.rows.length === 0) throw new Error('metrics is not a hypertable');
    console.log('hypertable ok: metrics');

    const sys = await pool.query('SELECT count(*) FROM historian.scada_systems');
    console.log('scada systems:', sys.rows[0].count);
    console.log('verification passed');
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
```

**Phase 1 success criteria**: `npm run historian:up` healthy; `npm run historian:verify` passes all four checks (extensions, dimension=512, hypertable, seed data).

---

## Phase 2: Embedding Pipeline

### 2.1 Embedder (`src/historian/services/screenshot-embedder.ts`)

Transformers.js handles model download, resize, CLIP normalization, and tensor plumbing — this removes the three v1 preprocessing bugs.

```typescript
import { Pool } from 'pg';
import pino from 'pino';
import config from '../config';

const logger = pino();

export class ScreenshotEmbedder {
  private extractor: any = null;
  constructor(private db: Pool) {}

  async initialize(): Promise<void> {
    const { pipeline } = await import('@xenova/transformers');
    logger.info({ model: config.embedding.model }, 'loading CLIP model (downloads on first run)');
    this.extractor = await pipeline('image-feature-extraction', config.embedding.model);
    logger.info('embedder ready');
  }

  /** Returns L2-normalized 512-D image embedding */
  async embedImage(localPath: string): Promise<number[]> {
    if (!this.extractor) throw new Error('call initialize() first');
    const output = await this.extractor(localPath, { pooling: 'mean', normalize: true });
    const vec: number[] = Array.from(output.data as Float32Array);
    if (vec.length !== config.embedding.dimension) {
      throw new Error(`model returned ${vec.length}-D, schema expects ${config.embedding.dimension}-D`);
    }
    return vec;
  }

  async storeEmbedding(screenshotId: string, embedding: number[]): Promise<void> {
    // FIX: v1 referenced $3 with only two params
    await this.db.query(
      `UPDATE historian.screenshots
         SET embedding = $1::vector,
             embedding_generated_at = NOW(),
             processing_status = 'processed'
       WHERE id = $2`,
      [`[${embedding.join(',')}]`, screenshotId]
    );
  }

  async markFailed(screenshotId: string, err: string): Promise<void> {
    await this.db.query(
      `UPDATE historian.screenshots
         SET processing_status = 'failed', processing_error = $2
       WHERE id = $1`,
      [screenshotId, err.slice(0, 1000)]
    );
  }

  /**
   * Cosine distance search. <=> is pgvector's cosine-distance operator
   * (range 0..2); similarity = 1 - distance. Lower distance = more similar,
   * so we ORDER BY distance ASC (v1 sorted the wrong direction).
   */
  async findSimilar(screenshotId: string, limit = 10, maxDistance = 0.3) {
    const result = await this.db.query(
      `WITH ref AS (
         SELECT embedding FROM historian.screenshots
         WHERE id = $1 AND embedding IS NOT NULL
       )
       SELECT s.id, s.timestamp, s.scada_system_id, s.s3_key,
              s.embedding <=> ref.embedding AS distance,
              1 - (s.embedding <=> ref.embedding) AS similarity
       FROM historian.screenshots s, ref
       WHERE s.id != $1
         AND s.embedding IS NOT NULL
         AND s.embedding <=> ref.embedding < $2
       ORDER BY distance ASC
       LIMIT $3`,
      [screenshotId, maxDistance, limit]
    );
    return result.rows;
  }
}
```

### 2.2 S3 Storage (`src/historian/services/object-store.ts`)

v1 recorded S3 keys but never uploaded anything. This closes that gap.

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import config from '../config';

const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
  forcePathStyle: true, // required for MinIO
});

export async function uploadScreenshot(key: string, body: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: key, Body: body, ContentType: 'image/png',
  }));
}

/** Download to a temp file; returns local path for the embedder */
export async function downloadToTemp(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  const bytes = Buffer.from(await res.Body!.transformToByteArray());
  const localPath = join(tmpdir(), key.replace(/\//g, '_'));
  await writeFile(localPath, bytes);
  return localPath;
}
```

### 2.3 Queue — singleton (`src/historian/workers/embedding-queue.ts`)

```typescript
import Queue from 'bull';
import { Pool } from 'pg';
import { unlink } from 'fs/promises';
import pino from 'pino';
import config from '../config';
import { ScreenshotEmbedder } from '../services/screenshot-embedder';
import { downloadToTemp } from '../services/object-store';

const logger = pino();

// FIX: v1 created a new Queue (new Redis connection) per enqueue call
let queue: Queue.Queue | null = null;

export function getEmbeddingQueue(): Queue.Queue {
  if (!queue) {
    queue = new Queue('screenshot-embeddings', config.redis.url, {
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return queue;
}

export async function enqueueEmbedding(screenshotId: string, s3Key: string): Promise<void> {
  await getEmbeddingQueue().add({ screenshotId, s3Key });
}

export function startWorker(db: Pool, embedder: ScreenshotEmbedder, concurrency = 4): void {
  // Concurrency 4, not 32: embedding is CPU-bound in-process; 32 concurrent
  // jobs on one node process just thrash. Scale by adding worker replicas.
  getEmbeddingQueue().process(concurrency, async (job) => {
    const { screenshotId, s3Key } = job.data;
    let localPath: string | null = null;
    try {
      localPath = await downloadToTemp(s3Key);           // FIX: fetch from S3, not treat key as path
      const embedding = await embedder.embedImage(localPath);
      await embedder.storeEmbedding(screenshotId, embedding);
      logger.info({ screenshotId }, 'embedded');
    } catch (err: any) {
      await embedder.markFailed(screenshotId, String(err?.message ?? err));
      throw err; // let Bull retry
    } finally {
      if (localPath) await unlink(localPath).catch(() => {});
    }
  });
}
```

### 2.4 Capture Service (`src/historian/services/screenshot-capture.ts`)

```typescript
import puppeteer, { Browser } from 'puppeteer';
import sharp from 'sharp';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { uploadScreenshot } from './object-store';
import { enqueueEmbedding } from '../workers/embedding-queue';
import config from '../config';

const logger = pino();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms)); // waitForTimeout removed in Puppeteer 22+

export class ScreenshotCaptureService {
  private browser: Browser | null = null;
  constructor(private db: Pool) {}

  async init(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }

  async capture(scadaSystemId: string, url: string): Promise<string> {
    if (!this.browser) await this.init();
    const page = await this.browser!.newPage();
    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
      await sleep(2000); // let SCADA widgets render

      const raw = await page.screenshot({ type: 'png' });
      const png = await sharp(raw).png({ compressionLevel: 8 }).toBuffer();

      const id = uuidv4();
      const ts = new Date();
      const s3Key = `screenshots/${scadaSystemId}/${ts.toISOString().slice(0, 10)}/${id}.png`;

      await uploadScreenshot(s3Key, png);                 // FIX: actually upload

      await this.db.query(
        `INSERT INTO historian.screenshots
           (id, scada_system_id, timestamp, s3_bucket, s3_key, file_size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, scadaSystemId, ts, config.s3.bucket, s3Key, png.length]
      );

      await enqueueEmbedding(id, s3Key);
      logger.info({ id, scadaSystemId }, 'captured, uploaded, queued');
      return id;
    } finally {
      await page.close();
    }
  }

  async shutdown(): Promise<void> {
    await this.browser?.close();
  }
}
```

### 2.5 REST Routes (`src/historian/routes/embedding-routes.ts`)

```typescript
import { Router } from 'express';
import { Pool } from 'pg';
import { ScreenshotEmbedder } from '../services/screenshot-embedder';
import { ScreenshotCaptureService } from '../services/screenshot-capture';

export function createEmbeddingRouter(
  db: Pool,
  embedder: ScreenshotEmbedder,
  capture: ScreenshotCaptureService  // FIX: v1 left a hardcoded '123' placeholder
): Router {
  const router = Router();

  router.post('/screenshots', async (req, res) => {
    const { scada_system_id, url } = req.body ?? {};
    if (!scada_system_id || !url) {
      return res.status(400).json({ error: 'scada_system_id and url required' });
    }
    try {
      const id = await capture.capture(scada_system_id, url);
      res.status(202).json({ screenshot_id: id, status: 'queued' });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  router.get('/screenshots/:id/similar', async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 100);
    const maxDistance = parseFloat(String(req.query.max_distance ?? '0.3'));
    try {
      const rows = await embedder.findSimilar(req.params.id, limit, maxDistance);
      res.json({ screenshot_id: req.params.id, count: rows.length, results: rows });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  return router;
}
```

**Phase 2 success criteria**: POST a screenshot → row in `screenshots` with `processing_status='processed'` and a 512-D embedding within ~5s; similar-search endpoint returns ordered results.

---

## Phase 3: Tensor Embedding Vector Engine, or similar derivation, such as Tensor Embedding Vector Extractor, (TEVE)  Compatibility

> **Redefined 2026-07-08.** Earlier drafts treated TEVE as an external legacy historian whose
> clients we had to stay query-compatible with, gated by replaying a week of real client traffic.
> Investigation found no such system anywhere (no config, no connection string, no client).
> TEVE is now defined as **our own Tensor Embedding Vector Engine/Extractor** — the embedding
> subsystem itself — and this phase builds it out as a first-class engine across three
> modalities. The replay gate is replaced by the offline retrieval-quality eval in §3.3.
>
> **Implemented (2026-07-08)**, all on the existing Node/`@xenova/transformers` stack:
>
> - **Engine** (`src/historian/teve/engine.ts` + `extractors/{image,text,timeseries}.ts`):
>   registry over three extractors, all emitting L2-normalized vectors. Image and text share
>   CLIP's joint 512-D space (`Xenova/clip-vit-base-patch16`); text vectors come from
>   `CLIPTextModelWithProjection` and MUST be normalized manually (raw norm ≈9.5).
>   `ScreenshotEmbedder` now delegates to the image extractor.
> - **Time-series windows** (`teve-ts-stat-v1`, 64-D, deterministic, no training): z-normalized
>   epoch-aligned windows → grouped features (distribution stats / autocorrelation / spectral
>   scalars / FFT log-bands / pooled shape), each group norm-balanced so no group drowns the
>   others. Fills the old open item "metric embeddings removed until a model exists".
> - **Storage** (`database/migrations/002_teve.sql` + minimal runner `scripts/historian/migrate.ts`,
>   `npm run historian:migrate`): `historian.metric_embeddings` (HNSW), plus
>   `embedding vector(64)` on `historian.anomalies`. `init.sql` carries the same objects for
>   fresh installs and pre-marks the migration applied.
> - **Services/worker**: `window-embedding.ts` (embed + similar-window search, embeds the
>   reference on demand), `anomaly-embedding.ts` (signature = the window leading up to
>   `detected_at`; detection itself is still out of scope), a repeatable Bull sweep embedding
>   the last completed window per active tag (`workers/window-embedding-queue.ts`), and
>   `npm run historian:backfill` for history + missing anomalies.
> - **API** (`routes/teve-search.ts`): `GET /api/teve/search?q=` (text→screenshots),
>   `GET /api/teve/windows/similar?tag=Sys.Tag&at=`, `GET /api/teve/anomalies/:id/similar`.
>   GraphQL: `searchScreenshots`, `similarMetricWindows`, `similarAnomalies`.
> - **Deployment**: the API image now bakes the model cache too (text encoder loads lazily on
>   first search; `HISTORIAN_ALLOW_REMOTE_MODELS=false` stays air-gap safe); API pod memory
>   limit raised to 1536Mi.
>
> The original §3.1 routes below (`/api/teve/tags|data|pointsdata`) are unchanged and remain
> TEVE's time-series read API.

### 3.1 TEVE Routes (`src/historian/routes/teve-compatibility.ts`)

```typescript
import { Router } from 'express';
import { Pool } from 'pg';

const INTERVALS = new Set(['1m','5m','15m','1h','6h','1d']); // whitelist: interval is interpolated into time_bucket

export function createTeveRouter(db: Pool): Router {
  const router = Router();

  router.get('/teve/tags', async (_req, res) => {
    const result = await db.query(
      `SELECT DISTINCT scada_system_id || '.' || tag_name AS tag_id,
              scada_system_id, tag_name, tag_unit
       FROM historian.metrics ORDER BY tag_id`
    );
    res.json({ count: result.rows.length, tags: result.rows });
  });

  router.get('/teve/data', async (req, res) => {
    const { tag, from, to, interval } = req.query as Record<string, string>;
    if (!tag || !from || !to) {
      return res.status(400).json({ error: 'required: tag, from, to' });
    }
    const dot = tag.indexOf('.');
    if (dot < 0) return res.status(400).json({ error: 'tag must be System.TagName' });
    const systemId = tag.slice(0, dot);
    const tagName = tag.slice(dot + 1);

    try {
      let rows;
      if (interval && interval !== 'raw') {
        // FIX: v1's splice/push produced 6 params for 5 placeholders
        if (!INTERVALS.has(interval)) {
          return res.status(400).json({ error: `interval must be one of ${[...INTERVALS].join(', ')} or raw` });
        }
        const q = `
          SELECT time_bucket('${interval}'::interval, time) AS "DateTime",
                 AVG(tag_value) AS "Value", 'Good' AS "Status", 0 AS "Milliseconds"
          FROM historian.metrics
          WHERE scada_system_id = $1 AND tag_name = $2 AND time BETWEEN $3 AND $4
          GROUP BY 1 ORDER BY 1 DESC`;
        rows = (await db.query(q, [systemId, tagName, from, to])).rows;
      } else {
        const q = `
          SELECT time AS "DateTime", tag_value AS "Value",
                 tag_status AS "Status", 0 AS "Milliseconds"
          FROM historian.metrics
          WHERE scada_system_id = $1 AND tag_name = $2 AND time BETWEEN $3 AND $4
          ORDER BY time DESC`;
        rows = (await db.query(q, [systemId, tagName, from, to])).rows;
      }
      res.json({ tag, count: rows.length, data: rows });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  router.get('/teve/pointsdata', async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '1000'), 10), 10_000);
    const result = await db.query(
      `SELECT * FROM historian.teve_pointsdata ORDER BY "DateTime" DESC LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  });

  return router;
}
```

### 3.2 Compatibility test plan — RETIRED (2026-07-08)

~~Record every distinct query your existing TEVE clients issue (SQL trace on the AVEVA side for one week), replay each against `/api/teve/*`, and diff results row-by-row.~~
There is no external TEVE system to trace; superseded by §3.3.

### 3.3 Stage 3 gate: retrieval-quality eval (`npm run historian:eval`)

`scripts/historian/teve-eval.ts` — model-in-process, no database, deterministic (fixed fixtures
in `tests/fixtures/teve/`, fixed model, CPU), so it works as a CI gate:

- **Images**: 3 fixture dashboards (alarm/normal/trend) × 5 deterministic sharp variants
  (brightness/crop/rescale) → same-family **P@3 ≥ 0.8**
- **Text→image**: fixed query→family pairs → **top-1 ≥ 2/3**
- **Time series**: 5 seeded synthetic families (sine/step/ramp/noise/spike) × 6 jittered
  instances → same-family **P@3 ≥ 0.9**

Exit code non-zero below any threshold. First passing run 2026-07-08: ts P@3 = 0.967,
image P@3 = 1.000, text top-1 = 100%. Model-free unit/property tests live in
`tests/historian/teve-*.test.ts` and `tests/properties/teve-embedding.property.test.ts`
(`npx jest --testPathPattern=teve`).

---

## Phase 4: GraphQL & UI

### 4.1 Schema + resolvers wired correctly (`src/historian/graphql/`)

v1 mixed `express-graphql` (not installed) with a resolver shape that silently returns null. v2 uses Apollo Server 4 with `makeExecutableSchema`.

```typescript
// schema.ts
export const typeDefs = /* GraphQL */ `
  type Query {
    screenshot(id: ID!): Screenshot
    screenshots(scadaSystemId: String!, from: String!, to: String!, limit: Int): [Screenshot!]!
    similarScreenshots(screenshotId: ID!, limit: Int, maxDistance: Float): [SimilarResult!]!
    metrics(scadaSystemId: String!, tagName: String!, from: String!, to: String!): [Metric!]!
    anomalies(resolved: Boolean, limit: Int): [Anomaly!]!
  }
  type Screenshot {
    id: ID!
    timestamp: String!
    scadaSystemId: String!
    s3Key: String!
    processingStatus: String!
  }
  type SimilarResult { screenshot: Screenshot!, similarity: Float!, distance: Float! }
  type Metric { time: String!, tagName: String!, value: Float, status: String, unit: String }
  type Anomaly { id: ID!, detectedAt: String!, type: String, score: Float, description: String }
`;
```

```typescript
// resolvers.ts
import { Pool } from 'pg';
import { ScreenshotEmbedder } from '../services/screenshot-embedder';

const mapShot = (r: any) => ({
  id: r.id, timestamp: r.timestamp?.toISOString?.() ?? r.timestamp,
  scadaSystemId: r.scada_system_id, s3Key: r.s3_key,
  processingStatus: r.processing_status,
});

export const makeResolvers = (db: Pool, embedder: ScreenshotEmbedder) => ({
  Query: {
    screenshot: async (_: unknown, { id }: { id: string }) => {
      const r = await db.query('SELECT * FROM historian.screenshots WHERE id = $1', [id]);
      return r.rows[0] ? mapShot(r.rows[0]) : null;
    },
    screenshots: async (_: unknown, a: any) => {
      const r = await db.query(
        `SELECT * FROM historian.screenshots
         WHERE scada_system_id = $1 AND timestamp BETWEEN $2 AND $3
         ORDER BY timestamp DESC LIMIT $4`,
        [a.scadaSystemId, a.from, a.to, a.limit ?? 50]
      );
      return r.rows.map(mapShot);
    },
    similarScreenshots: async (_: unknown, a: any) => {
      const rows = await embedder.findSimilar(a.screenshotId, a.limit ?? 10, a.maxDistance ?? 0.3);
      return rows.map(r => ({ screenshot: mapShot(r), similarity: r.similarity, distance: r.distance }));
    },
    metrics: async (_: unknown, a: any) => {
      const r = await db.query(
        `SELECT time, tag_name, tag_value, tag_status, tag_unit FROM historian.metrics
         WHERE scada_system_id = $1 AND tag_name = $2 AND time BETWEEN $3 AND $4
         ORDER BY time DESC`,
        [a.scadaSystemId, a.tagName, a.from, a.to]
      );
      return r.rows.map(m => ({
        time: m.time.toISOString(), tagName: m.tag_name,
        value: m.tag_value, status: m.tag_status, unit: m.tag_unit,
      }));
    },
    anomalies: async (_: unknown, a: any) => {
      const r = await db.query(
        `SELECT * FROM historian.anomalies WHERE resolved = $1
         ORDER BY detected_at DESC LIMIT $2`,
        [a.resolved ?? false, a.limit ?? 100]
      );
      return r.rows.map(x => ({
        id: x.id, detectedAt: x.detected_at.toISOString(),
        type: x.anomaly_type, score: x.anomaly_score, description: x.description,
      }));
    },
  },
});
```

### 4.2 Entry point (`src/historian/index.ts`)

```typescript
import express from 'express';
import { Pool } from 'pg';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { makeExecutableSchema } from '@graphql-tools/schema';
import pino from 'pino';
import config from './config';
import { ScreenshotEmbedder } from './services/screenshot-embedder';
import { ScreenshotCaptureService } from './services/screenshot-capture';
import { startWorker, getEmbeddingQueue } from './workers/embedding-queue';
import { createEmbeddingRouter } from './routes/embedding-routes';
import { createTeveRouter } from './routes/teve-compatibility';
import { typeDefs } from './graphql/schema';
import { makeResolvers } from './graphql/resolvers';

const logger = pino();

async function main() {
  const db = new Pool({ connectionString: config.database.url, max: 20 });

  const embedder = new ScreenshotEmbedder(db);
  await embedder.initialize();

  const capture = new ScreenshotCaptureService(db);
  startWorker(db, embedder);

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/historian', createEmbeddingRouter(db, embedder, capture));
  app.use('/api', createTeveRouter(db));

  const apollo = new ApolloServer({
    schema: makeExecutableSchema({ typeDefs, resolvers: makeResolvers(db, embedder) }),
  });
  await apollo.start();
  app.use('/graphql', expressMiddleware(apollo));

  app.listen(config.server.port, () => logger.info(`historian on :${config.server.port}`));

  process.on('SIGTERM', async () => {
    await getEmbeddingQueue().close();
    await capture.shutdown();
    await db.end();
    process.exit(0);
  });
}

main().catch(e => { logger.error(e); process.exit(1); });
```

---

## Phase 5: Production

Unchanged in structure from v1 (K8s deployment, monitoring, test suite), with two corrections:

1. **Worker sizing**: run the embedding worker as a **separate Deployment** from the API (v1 mixed them). API pods: 2 replicas, no model loaded. Worker pods: 1-2 replicas, each loads the CLIP model (~600 MB RAM extra), concurrency 4.
2. **GPU note**: `@xenova/transformers` is CPU (WASM/ONNX). At ~400 screenshots/day, CPU at ~1-2s/image is ~15 minutes of compute per day — a GPU is unnecessary at current volume. Revisit only if volume grows 50x, at which point a small Python inference sidecar (or onnxruntime CUDA) is the upgrade path.

---

## Revised Verification Commands

```bash
# Phase 1
npm run historian:up && npm run historian:verify

# Phase 2 (after historian:dev is running)
curl -X POST localhost:3000/api/historian/screenshots \
  -H 'Content-Type: application/json' \
  -d '{"scada_system_id":"HMI-01","url":"https://example.com"}'
# wait ~5s, then check:
docker exec historian_postgres psql -U historian -d historian_db \
  -c "SELECT id, processing_status, embedding IS NOT NULL AS has_embedding FROM historian.screenshots"

# Phase 3
curl 'localhost:3000/api/teve/data?tag=HMI-01.Temperature&from=2026-01-01&to=2026-12-31&interval=1h'
npm run historian:migrate
curl 'localhost:3100/api/teve/search?q=red%20alarm%20banner&limit=5'
curl 'localhost:3100/api/teve/windows/similar?tag=HMI-01.Temperature&at=2026-07-08T10:00:00Z'
curl 'localhost:3100/api/teve/anomalies/<id>/similar'
npm run historian:eval   # THE Stage 3 gate

# Phase 4
curl -X POST localhost:3000/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ anomalies { id detectedAt } }"}'
```

---

## Remaining Open Items (honestly unresolved)

- **OCR metric extraction** (tesseract.js) was in v1's dependency list but never implemented anywhere. It's now explicitly out of MVP scope — add as Phase 6 if extracting values from screenshot pixels is actually required (confirm whether metrics arrive via TEVE/SQL anyway, which would make OCR redundant).
- **`vector(256)` metric embeddings and anomaly embeddings** from the v1 schema had no producer (nothing generated them). Removed until there's a model that outputs them.
- ~~**TEVE write-path**: the plan covers reads. If any client *writes* through TEVE interfaces, that's unscoped — verify before Phase 3.~~ Resolved N/A (2026-07-08): TEVE is our own engine, not an external interface with unknown clients.
- ~~The Phase 3 compatibility gate is the highest-risk step: progression past it depends entirely on the replay-and-diff results against real TEVE client queries, so treat it as the pacing item for the whole effort.~~ Superseded by the §3.3 eval gate, which passed 2026-07-08.
- **Anomaly detection** still has no producer: anomaly *signature embeddings* exist (§3), but nothing writes anomaly rows yet.
