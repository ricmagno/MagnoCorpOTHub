import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import config from '../config/index';
import { requireAdminToken } from '../middleware/admin-auth';

// Bearer-token auth for all admin endpoints. Fails closed when HISTORIAN_ADMIN_TOKEN
// is unset and compares in constant time — see ../middleware/admin-auth.ts.
const authMiddleware = requireAdminToken;

export function createAdminDashboardRouter(db: Pool): Router {
  const router = Router();

  /**
   * GET /admin/config — return current TEVE configuration (read-only display).
   * Excludes secrets; only shows connection endpoints (not credentials).
   */
  router.get('/admin/config', authMiddleware, async (_req: Request, res: Response) => {
    try {
      const configData = {
        database: {
          url: config.database.url.replace(/:[^@]+@/, ':***@'), // mask password
          isConnected: false, // set below after test query
        },
        s3: {
          endpoint: config.s3.endpoint,
          bucket: config.s3.bucket,
          region: config.s3.region,
        },
        redis: {
          url: config.redis.url.replace(/:([^@]+)@/, ':***@'), // mask password
        },
        embedding: {
          model: config.embedding.model,
          dimension: config.embedding.dimension,
          allowRemoteModels: config.embedding.allowRemoteModels,
          cacheDir: config.embedding.cacheDir,
        },
        server: {
          port: config.server.port,
        },
        worker: {
          concurrency: config.worker.concurrency,
          healthPort: config.worker.healthPort,
        },
        teve: {
          tsWindowMinutes: config.teve.tsWindowMinutes,
          tsEmbedEveryMinutes: config.teve.tsEmbedEveryMinutes,
        },
      };

      // Test database connectivity
      try {
        await db.query('SELECT 1');
        configData.database.isConnected = true;
      } catch {
        configData.database.isConnected = false;
      }

      res.json(configData);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * GET /admin/status — return current health and statistics.
   */
  router.get('/admin/status', authMiddleware, async (_req: Request, res: Response) => {
    try {
      // Get database stats
      let metricsCount = 0;
      let tagsCount = 0;
      let oldestMetricTime: string | null = null;
      let newestMetricTime: string | null = null;

      try {
        const metricsResult = await db.query(
          'SELECT COUNT(*) as count, MIN(time) as oldest, MAX(time) as newest FROM historian.metrics'
        );
        if (metricsResult.rows[0]) {
          metricsCount = parseInt(metricsResult.rows[0].count, 10);
          oldestMetricTime = metricsResult.rows[0].oldest;
          newestMetricTime = metricsResult.rows[0].newest;
        }

        const tagsResult = await db.query(
          'SELECT COUNT(DISTINCT scada_system_id || \'.\' || tag_name) as count FROM historian.metrics'
        );
        if (tagsResult.rows[0]) {
          tagsCount = parseInt(tagsResult.rows[0].count, 10);
        }
      } catch (dbErr) {
        // Database may be down or metrics table doesn't exist yet
      }

      res.json({
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        database: {
          metrics_count: metricsCount,
          unique_tags: tagsCount,
          oldest_metric: oldestMetricTime,
          newest_metric: newestMetricTime,
        },
        version: process.env.npm_package_version || 'unknown',
        nodeVersion: process.version,
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * GET /admin/logs — return recent log entries (if logging to database is implemented).
   * For now, returns a placeholder; in production, query a logs table or aggregator.
   */
  router.get('/admin/logs', authMiddleware, async (_req: Request, res: Response) => {
    try {
      // Placeholder: in a real system, query historian.logs table or fetch from a logging service
      res.json({
        message: 'Logging endpoint — not yet implemented in this deployment',
        placeholder: [
          { timestamp: new Date().toISOString(), level: 'INFO', message: 'TEVE service is running' },
        ],
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * POST /admin/clear-cache — clear the embedding model cache (forces reload on next inference).
   * Useful for freeing memory or forcing a model update.
   */
  router.post('/admin/clear-cache', authMiddleware, async (_req: Request, res: Response) => {
    try {
      // In a real system, this would signal the worker to clear fs.cache or call tf.dispose().
      // For now, just return success (actual implementation depends on the embedding framework).
      res.json({ message: 'Cache clear signaled (actual implementation framework-dependent)' });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * GET /admin/health — simple liveness check for Kubernetes probes.
   */
  router.get('/admin/health', async (_req: Request, res: Response) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'unhealthy', error: 'database unreachable' });
    }
  });

  return router;
}
