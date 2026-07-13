import Queue from 'bull';
import { Pool } from 'pg';
import { unlink } from 'fs/promises';
import pino from 'pino';
import config from '../config';
import { ScreenshotEmbedder } from '../services/screenshot-embedder';
import { downloadToTemp } from '../services/object-store';

const logger = pino();

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
  // Concurrency 4: embedding is CPU-bound in-process; higher concurrency on one
  // node process just thrashes. Scale by adding worker replicas instead.
  getEmbeddingQueue().process(concurrency, async (job) => {
    const { screenshotId, s3Key } = job.data;
    let localPath: string | null = null;
    try {
      localPath = await downloadToTemp(s3Key);
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
