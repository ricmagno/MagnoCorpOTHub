import { Router } from 'express';
import { Pool } from 'pg';
import { TeveEngine, parseTagId } from '../teve/engine';
import { WindowEmbeddingService } from '../services/window-embedding';
import { AnomalyEmbeddingService } from '../services/anomaly-embedding';

/**
 * TEVE vector-search routes (Stage 3): text→screenshot search, similar metric
 * windows, similar anomalies. Mounted under the same /api prefix as
 * teve-compatibility.ts, so paths land at /api/teve/*.
 */
export function createTeveSearchRouter(
  db: Pool,
  engine: TeveEngine,
  windows: WindowEmbeddingService,
  anomalies: AnomalyEmbeddingService
): Router {
  const router = Router();

  router.get('/teve/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.status(400).json({ error: 'required: q (text query)' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 100);
    try {
      const vec = await engine.embedText(q);
      // No max_distance cutoff by default: CLIP text↔image cosine similarities sit in
      // a lower absolute range (~0.2–0.3 for good matches) than image↔image, so this
      // is a ranking API — take the top K.
      const result = await db.query(
        `SELECT s.id, s.timestamp, s.scada_system_id, s.s3_key,
                s.embedding <=> $1::vector AS distance,
                1 - (s.embedding <=> $1::vector) AS similarity
         FROM historian.screenshots s
         WHERE s.embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT $2`,
        [`[${vec.join(',')}]`, limit]
      );
      res.json({ query: q, count: result.rows.length, results: result.rows });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  router.get('/teve/windows/similar', async (req, res) => {
    const tag = String(req.query.tag ?? '');
    const parsed = parseTagId(tag);
    if (!parsed) {
      res.status(400).json({ error: 'tag must be System.TagName' });
      return;
    }
    const at = new Date(String(req.query.at ?? ''));
    if (Number.isNaN(at.getTime())) {
      res.status(400).json({ error: 'required: at (ISO timestamp inside the reference window)' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 100);
    try {
      const found = await windows.findSimilarWindows(parsed.systemId, parsed.tagName, at, limit);
      if (!found) {
        res.status(404).json({ error: 'reference window has no/insufficient metric data to embed' });
        return;
      }
      res.json({
        tag,
        window_start: found.windowStart,
        count: found.results.length,
        results: found.results,
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  router.get('/teve/anomalies/:id/similar', async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 100);
    try {
      const results = await anomalies.findSimilarAnomalies(req.params.id, limit);
      if (results === null) {
        res.status(404).json({
          error: 'anomaly not found, or it cannot be embedded (needs a System.TagName metric_tag with data in the window before detected_at)',
        });
        return;
      }
      res.json({ anomaly_id: req.params.id, count: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  return router;
}
