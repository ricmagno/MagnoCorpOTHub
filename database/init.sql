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

-- 8. TEVE Stage 3 — time-series window embeddings (mirrors database/migrations/002_teve.sql;
-- keep both in sync: init.sql is the fresh-install baseline, migrations upgrade existing DBs)
CREATE TABLE historian.metric_embeddings (
    window_start TIMESTAMPTZ NOT NULL,
    window_end   TIMESTAMPTZ NOT NULL,
    scada_system_id TEXT NOT NULL,
    tag_name     TEXT NOT NULL,
    embedding    vector(64) NOT NULL,
    model        TEXT NOT NULL DEFAULT 'teve-ts-stat-v1',
    sample_count INTEGER NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (window_start, scada_system_id, tag_name, model)
);
CREATE INDEX idx_metric_emb_hnsw ON historian.metric_embeddings
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_metric_emb_tag ON historian.metric_embeddings
    (scada_system_id, tag_name, window_start DESC);

ALTER TABLE historian.anomalies
    ADD COLUMN embedding vector(64),
    ADD COLUMN embedding_model TEXT,
    ADD COLUMN embedded_at TIMESTAMPTZ;
CREATE INDEX idx_anomaly_emb_hnsw ON historian.anomalies
    USING hnsw (embedding vector_cosine_ops);

-- 9. Migration ledger — fresh installs already include the migrations listed here
CREATE TABLE historian.schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO historian.schema_migrations (filename) VALUES ('002_teve.sql')
ON CONFLICT DO NOTHING;
