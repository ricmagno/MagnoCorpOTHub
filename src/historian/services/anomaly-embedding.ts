import { Pool } from 'pg';
import pino from 'pino';
import config from '../config';
import { embedTimeseriesWindow, TS_MODEL } from '../teve/extractors/timeseries';
import { parseTagId } from '../teve/engine';

const logger = pino();

export interface SimilarAnomaly {
  id: string;
  detected_at: Date;
  metric_tag: string | null;
  anomaly_type: string | null;
  anomaly_score: number | null;
  description: string | null;
  resolved: boolean;
  distance: number;
  similarity: number;
}

/**
 * Embeds an anomaly's "signature": the metric window of length tsWindowMinutes
 * LEADING UP TO detected_at (the run-up is what characterizes an incident), in the
 * same 64-D space as metric window embeddings. Similar past incidents are then a
 * nearest-neighbour query over historian.anomalies.embedding.
 *
 * Anomaly *detection* is out of scope — nothing in this codebase creates anomaly
 * rows yet; this embeds rows however they get created.
 */
export class AnomalyEmbeddingService {
  constructor(private db: Pool) {}

  /**
   * Compute and store the embedding for one anomaly.
   * Returns false when the anomaly is missing, has no parseable metric_tag
   * ("System.TagName"), or its window has too little data.
   */
  async embedAnomaly(anomalyId: string): Promise<boolean> {
    const res = await this.db.query(
      'SELECT id, detected_at, metric_tag FROM historian.anomalies WHERE id = $1',
      [anomalyId]
    );
    const anomaly = res.rows[0];
    if (!anomaly) return false;
    const parsed = anomaly.metric_tag ? parseTagId(anomaly.metric_tag) : null;
    if (!parsed) return false;

    const windowMs = config.teve.tsWindowMinutes * 60_000;
    const end: Date = anomaly.detected_at;
    const start = new Date(end.getTime() - windowMs);
    const rows = await this.db.query(
      `SELECT time, tag_value FROM historian.metrics
       WHERE scada_system_id = $1 AND tag_name = $2 AND time >= $3 AND time < $4
       ORDER BY time ASC`,
      [parsed.systemId, parsed.tagName, start, end]
    );
    const vec = embedTimeseriesWindow(
      rows.rows.map((r: { time: Date; tag_value: unknown }) => ({ time: r.time, value: Number(r.tag_value) }))
    );
    if (!vec) return false;

    await this.db.query(
      `UPDATE historian.anomalies
         SET embedding = $2::vector, embedding_model = $3, embedded_at = NOW()
       WHERE id = $1`,
      [anomalyId, `[${vec.join(',')}]`, TS_MODEL]
    );
    logger.info({ anomalyId }, 'anomaly signature embedded');
    return true;
  }

  /** Embed every anomaly with a metric_tag but no embedding yet. Returns count embedded. */
  async embedMissing(): Promise<number> {
    const res = await this.db.query(
      `SELECT id FROM historian.anomalies WHERE embedding IS NULL AND metric_tag IS NOT NULL`
    );
    let embedded = 0;
    for (const row of res.rows) {
      if (await this.embedAnomaly(row.id)) embedded++;
    }
    return embedded;
  }

  /**
   * Nearest anomalies to the given one. Embeds the reference on demand if needed.
   * Returns null when the reference anomaly doesn't exist or can't be embedded.
   */
  async findSimilarAnomalies(anomalyId: string, limit = 10): Promise<SimilarAnomaly[] | null> {
    const ref = await this.db.query(
      'SELECT embedding IS NOT NULL AS has_embedding FROM historian.anomalies WHERE id = $1',
      [anomalyId]
    );
    if (!ref.rows[0]) return null;
    if (!ref.rows[0].has_embedding) {
      const ok = await this.embedAnomaly(anomalyId);
      if (!ok) return null;
    }
    const result = await this.db.query(
      `WITH ref AS (
         SELECT embedding, embedding_model FROM historian.anomalies WHERE id = $1
       )
       SELECT a.id, a.detected_at, a.metric_tag, a.anomaly_type, a.anomaly_score,
              a.description, a.resolved,
              a.embedding <=> ref.embedding AS distance,
              1 - (a.embedding <=> ref.embedding) AS similarity
       FROM historian.anomalies a, ref
       WHERE a.id != $1
         AND a.embedding IS NOT NULL
         AND a.embedding_model = ref.embedding_model
       ORDER BY distance ASC
       LIMIT $2`,
      [anomalyId, limit]
    );
    return result.rows;
  }
}
