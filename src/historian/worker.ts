import express from 'express';
import { Pool } from 'pg';
import pino from 'pino';
import config from './config';
import { ScreenshotEmbedder } from './services/screenshot-embedder';
import { startWorker, getEmbeddingQueue } from './workers/embedding-queue';
import { startWindowWorker, getWindowQueue } from './workers/window-embedding-queue';

const logger = pino();

/**
 * Production embedding-worker entry point — the only process that loads the ~600MB
 * CLIP model. Runs as its own Deployment so API pods stay light (see api.ts). No REST/
 * GraphQL surface; the /health endpoint exists only for the k8s liveness/readiness probes.
 */
async function main() {
  const db = new Pool({ connectionString: config.database.url, max: 10 });

  const embedder = new ScreenshotEmbedder(db);
  await embedder.initialize();

  startWorker(db, embedder, config.worker.concurrency);
  startWindowWorker(db);
  logger.info({ concurrency: config.worker.concurrency }, 'embedding worker ready');

  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.listen(config.worker.healthPort, () =>
    logger.info(`worker health on :${config.worker.healthPort}`)
  );

  process.on('SIGTERM', async () => {
    await getEmbeddingQueue().close();
    await getWindowQueue().close();
    await db.end();
    process.exit(0);
  });
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
