import express, { Router } from 'express';
import { Pool } from 'pg';
import sharp from 'sharp';
import { ScreenshotEmbedder } from '../services/screenshot-embedder';
import { ScreenshotCaptureService } from '../services/screenshot-capture';
import { downloadBuffer } from '../services/object-store';
import { requireAdminToken } from '../middleware/admin-auth';

export function createEmbeddingRouter(
  db: Pool,
  embedder: ScreenshotEmbedder,
  capture: ScreenshotCaptureService
): Router {
  const router = Router();

  router.get('/screenshots/:id/image', async (req, res) => {
    try {
      const result = await db.query(
        'SELECT s3_key FROM historian.screenshots WHERE id = $1',
        [req.params.id]
      );
      const s3Key = result.rows[0]?.s3_key;
      if (!s3Key) {
        res.status(404).json({ error: 'screenshot not found' });
        return;
      }
      const buf = await downloadBuffer(s3Key);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=31536000, immutable'); // s3_key is content-addressed by capture time+uuid, never mutated
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  router.post('/screenshots', async (req, res) => {
    const { scada_system_id, url } = req.body ?? {};
    if (!scada_system_id || !url) {
      res.status(400).json({ error: 'scada_system_id and url required' });
      return;
    }
    try {
      const id = await capture.capture(scada_system_id, url);
      res.status(202).json({ screenshot_id: id, status: 'queued' });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // os-agent ingest path: agents on thick-client SCADA nodes (no web HMI) POST raw
  // screen grabs here instead of the URL-driven Puppeteer capture above.
  router.post(
    '/screenshots/upload',
    requireAdminToken,
    express.raw({ type: 'image/*', limit: '20mb' }),
    async (req, res) => {
      const scadaSystemId = String(req.query.scada_system_id ?? '');
      if (!scadaSystemId) {
        res.status(400).json({ error: 'scada_system_id query parameter required' });
        return;
      }
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'image body required with an image/* Content-Type' });
        return;
      }
      try {
        const sys = await db.query(
          'SELECT 1 FROM historian.scada_systems WHERE id = $1',
          [scadaSystemId]
        );
        if (!sys.rows[0]) {
          res.status(404).json({ error: `unknown scada_system_id: ${scadaSystemId}` });
          return;
        }
        let png: Buffer;
        try {
          png = await sharp(body).png({ compressionLevel: 8 }).toBuffer();
        } catch {
          res.status(400).json({ error: 'body is not a decodable image' });
          return;
        }
        const id = await capture.ingest(scadaSystemId, png);
        res.status(202).json({ screenshot_id: id, status: 'queued' });
      } catch (err: any) {
        res.status(500).json({ error: String(err?.message ?? err) });
      }
    }
  );

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
