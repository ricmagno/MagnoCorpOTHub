import { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { ScreenshotEmbedder } from '../services/screenshot-embedder';
import { TeveEngine, parseTagId } from '../teve/engine';
import { WindowEmbeddingService } from '../services/window-embedding';
import { AnomalyEmbeddingService } from '../services/anomaly-embedding';

const mapShot = (r: any) => ({
  id: r.id, timestamp: r.timestamp?.toISOString?.() ?? r.timestamp,
  scadaSystemId: r.scada_system_id, s3Key: r.s3_key,
  processingStatus: r.processing_status,
});

const mapAnomaly = (x: any) => ({
  id: x.id, detectedAt: x.detected_at.toISOString(),
  type: x.anomaly_type, score: x.anomaly_score, description: x.description,
  resolved: x.resolved,
});

export interface TeveResolverDeps {
  engine: TeveEngine;
  windows: WindowEmbeddingService;
  anomalyEmbeddings: AnomalyEmbeddingService;
}

export const makeResolvers = (db: Pool, embedder: ScreenshotEmbedder, teve: TeveResolverDeps) => ({
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
    searchScreenshots: async (_: unknown, a: any) => {
      const query = String(a.query ?? '').trim();
      if (!query) throw new GraphQLError('query must be a non-empty string');
      const vec = await teve.engine.embedText(query);
      const r = await db.query(
        `SELECT s.*, s.embedding <=> $1::vector AS distance,
                1 - (s.embedding <=> $1::vector) AS similarity
         FROM historian.screenshots s
         WHERE s.embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT $2`,
        [`[${vec.join(',')}]`, Math.min(a.limit ?? 10, 100)]
      );
      return r.rows.map(row => ({ screenshot: mapShot(row), similarity: row.similarity, distance: row.distance }));
    },
    metrics: async (_: unknown, a: any) => {
      const r = await db.query(
        `SELECT time, tag_name, tag_value, tag_status, tag_unit FROM historian.metrics
         WHERE scada_system_id = $1 AND tag_name = $2 AND time BETWEEN $3 AND $4
         ORDER BY time DESC`,
        [a.scadaSystemId, a.tagName, a.from, a.to]
      );
      return r.rows.map((m: any) => ({
        time: m.time.toISOString(), tagName: m.tag_name,
        value: m.tag_value, status: m.tag_status, unit: m.tag_unit,
      }));
    },
    similarMetricWindows: async (_: unknown, a: any) => {
      const parsed = parseTagId(String(a.tag ?? ''));
      if (!parsed) throw new GraphQLError('tag must be System.TagName');
      const at = new Date(String(a.at ?? ''));
      if (Number.isNaN(at.getTime())) throw new GraphQLError('at must be an ISO timestamp');
      const found = await teve.windows.findSimilarWindows(
        parsed.systemId, parsed.tagName, at, Math.min(a.limit ?? 10, 100)
      );
      if (!found) throw new GraphQLError('reference window has no/insufficient metric data to embed');
      return found.results.map(w => ({
        scadaSystemId: w.scada_system_id,
        tagName: w.tag_name,
        windowStart: w.window_start.toISOString(),
        windowEnd: w.window_end.toISOString(),
        sampleCount: w.sample_count,
        similarity: w.similarity,
        distance: w.distance,
      }));
    },
    anomalies: async (_: unknown, a: any) => {
      const r = await db.query(
        `SELECT * FROM historian.anomalies WHERE resolved = $1
         ORDER BY detected_at DESC LIMIT $2`,
        [a.resolved ?? false, a.limit ?? 100]
      );
      return r.rows.map(mapAnomaly);
    },
    similarAnomalies: async (_: unknown, a: any) => {
      const results = await teve.anomalyEmbeddings.findSimilarAnomalies(
        String(a.anomalyId), Math.min(a.limit ?? 10, 100)
      );
      if (results === null) {
        throw new GraphQLError('anomaly not found or cannot be embedded (needs System.TagName metric_tag with window data)');
      }
      return results.map(r => ({ anomaly: mapAnomaly(r), similarity: r.similarity, distance: r.distance }));
    },
  },
});
