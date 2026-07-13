import Queue from 'bull';
import { Pool } from 'pg';
import pino from 'pino';
import config from '../config';
import { WindowEmbeddingService } from '../services/window-embedding';

const logger = pino();

// Singleton, same discipline as embedding-queue.ts: one Redis connection per process.
let queue: Queue.Queue | null = null;

export function getWindowQueue(): Queue.Queue {
  if (!queue) {
    queue = new Queue('window-embeddings', config.redis.url, {
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 20,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

const SWEEP_JOB = 'embed-recent-windows';

/**
 * Repeatable sweep: every tsEmbedEveryMinutes, embed the last *completed*
 * epoch-aligned window for every tag that was active in it. Concurrency 1 —
 * the sweep itself iterates tags; parallel sweeps would just contend.
 */
export function startWindowWorker(db: Pool): void {
  const q = getWindowQueue();
  const service = new WindowEmbeddingService(db);

  q.process(SWEEP_JOB, 1, async () => {
    const stored = await service.embedLastCompletedWindows();
    return { stored };
  });

  q.add(SWEEP_JOB, {}, {
    repeat: { every: config.teve.tsEmbedEveryMinutes * 60_000 },
    jobId: SWEEP_JOB,
  }).catch((err) => logger.error({ err }, 'failed to schedule window embedding sweep'));

  logger.info({ everyMinutes: config.teve.tsEmbedEveryMinutes }, 'window embedding worker ready');
}
