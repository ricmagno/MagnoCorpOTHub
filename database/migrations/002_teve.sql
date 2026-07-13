-- TEVE Stage 3: time-series window embeddings + anomaly signature embeddings.
-- Applied by scripts/historian/migrate.ts on existing databases; database/init.sql
-- carries the same objects as the fresh-install baseline (and pre-marks this file
-- as applied in historian.schema_migrations).

-- Plain table, not a hypertable: volume is low (~active tags × windows/day), and a
-- single HNSW index over one table beats per-chunk indexes at this scale.
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

-- Anomaly signatures: the 64-D embedding of the metric window leading up to
-- detected_at, in the SAME space as metric_embeddings, so "similar past incidents"
-- is a nearest-neighbour query over anomalies.
ALTER TABLE historian.anomalies
    ADD COLUMN embedding vector(64),
    ADD COLUMN embedding_model TEXT,
    ADD COLUMN embedded_at TIMESTAMPTZ;

CREATE INDEX idx_anomaly_emb_hnsw ON historian.anomalies
    USING hnsw (embedding vector_cosine_ops);
