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
    const { tag, from, to, interval, limit } = req.query as Record<string, string>;
    if (!tag || !from || !to) {
      res.status(400).json({ error: 'required: tag, from, to' });
      return;
    }
    const dot = tag.indexOf('.');
    if (dot < 0) {
      res.status(400).json({ error: 'tag must be System.TagName' });
      return;
    }
    const systemId = tag.slice(0, dot);
    const tagName = tag.slice(dot + 1);

    // Optional cap on rows, e.g. limit=1 for a "latest value only" live-widget
    // fetch instead of the caller pulling the whole time range every poll.
    // Both branches already ORDER BY ... DESC, so LIMIT gives the N most recent points.
    let limitClause = '';
    if (limit !== undefined) {
      const parsedLimit = parseInt(limit, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 10_000) {
        res.status(400).json({ error: 'limit must be an integer between 1 and 10000' });
        return;
      }
      limitClause = `LIMIT ${parsedLimit}`;
    }

    try {
      let rows;
      if (interval && interval !== 'raw') {
        if (!INTERVALS.has(interval)) {
          res.status(400).json({ error: `interval must be one of ${[...INTERVALS].join(', ')} or raw` });
          return;
        }
        const q = `
          SELECT time_bucket('${interval}'::interval, time) AS "DateTime",
                 AVG(tag_value) AS "Value", 'Good' AS "Status", 0 AS "Milliseconds"
          FROM historian.metrics
          WHERE scada_system_id = $1 AND tag_name = $2 AND time BETWEEN $3 AND $4
          GROUP BY 1 ORDER BY 1 DESC ${limitClause}`;
        rows = (await db.query(q, [systemId, tagName, from, to])).rows;
      } else {
        const q = `
          SELECT time AS "DateTime", tag_value AS "Value",
                 tag_status AS "Status", 0 AS "Milliseconds"
          FROM historian.metrics
          WHERE scada_system_id = $1 AND tag_name = $2 AND time BETWEEN $3 AND $4
          ORDER BY time DESC ${limitClause}`;
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

  /**
   * Batch metric ingest — lets TEVE be used as a genuine alternative (or
   * parallel) historian, not just a read-side search layer: an external collector
   * (e.g. the main app's teveIngestService, subscribed to OPC UA tags)
   * pushes live values here instead of writing to Postgres directly, keeping this
   * service's schema/DB credentials private to itself.
   */
  router.post('/teve/ingest', async (req, res) => {
    const { scadaSystem, metrics } = req.body ?? {};
    if (!scadaSystem?.id || typeof scadaSystem.id !== 'string') {
      res.status(400).json({ error: 'scadaSystem.id is required' });
      return;
    }
    if (!Array.isArray(metrics) || metrics.length === 0) {
      res.status(400).json({ error: 'metrics must be a non-empty array' });
      return;
    }
    if (metrics.length > 5000) {
      res.status(400).json({ error: 'metrics batch too large (max 5000)' });
      return;
    }
    for (const m of metrics) {
      if (!m || typeof m.tagName !== 'string' || !m.tagName || !m.time) {
        res.status(400).json({ error: 'each metric requires tagName and time' });
        return;
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO historian.scada_systems (id, name, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [scadaSystem.id, scadaSystem.name ?? scadaSystem.id, scadaSystem.description ?? 'OPC UA ingestion source']
      );

      const values: unknown[] = [];
      const rows: string[] = [];
      metrics.forEach((m: any, i: number) => {
        const base = i * 6;
        rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        values.push(m.time, scadaSystem.id, m.tagName, m.value ?? null, m.status ?? 'Good', m.unit ?? null);
      });
      await client.query(
        `INSERT INTO historian.metrics (time, scada_system_id, tag_name, tag_value, tag_status, tag_unit)
         VALUES ${rows.join(',')}
         ON CONFLICT (time, scada_system_id, tag_name) DO UPDATE
           SET tag_value = EXCLUDED.tag_value, tag_status = EXCLUDED.tag_status, tag_unit = EXCLUDED.tag_unit`,
        values
      );
      await client.query('COMMIT');
      res.status(202).json({ ingested: metrics.length });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: String(err?.message ?? err) });
    } finally {
      client.release();
    }
  });

  return router;
}
