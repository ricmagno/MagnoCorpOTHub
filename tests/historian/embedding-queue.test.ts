/**
 * Unit tests for the embedding queue worker. Bull, pino, and fs/promises are mocked —
 * these verify queue wiring and the processor's control flow (retry/cleanup behavior),
 * not a real Redis connection.
 *
 * The module under test holds a module-level singleton (`queue`), so every test
 * requires it (and its mocked deps) fresh after jest.resetModules() — otherwise the
 * singleton from an earlier test would leak in and every "constructs a queue" style
 * assertion would see zero additional constructor calls.
 */
jest.mock('bull', () => jest.fn());
jest.mock('pino', () => jest.fn(() => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
})));
jest.mock('fs/promises', () => ({
  unlink: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/historian/services/object-store', () => ({
  downloadToTemp: jest.fn(),
}));

function makeMockQueueInstance() {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    process: jest.fn(),
  };
}

let MockQueue: jest.Mock;
let unlink: jest.Mock;
let downloadToTemp: jest.Mock;
let embeddingQueue: typeof import('../../src/historian/workers/embedding-queue');

beforeEach(() => {
  jest.resetModules();
  MockQueue = require('bull');
  MockQueue.mockImplementation(() => makeMockQueueInstance());
  unlink = require('fs/promises').unlink;
  downloadToTemp = require('../../src/historian/services/object-store').downloadToTemp;
  embeddingQueue = require('../../src/historian/workers/embedding-queue');
});

describe('getEmbeddingQueue', () => {
  it('constructs a Bull queue named screenshot-embeddings with the expected job options', () => {
    embeddingQueue.getEmbeddingQueue();

    expect(MockQueue).toHaveBeenCalledTimes(1);
    const [name, redisUrl, opts] = MockQueue.mock.calls[0];
    expect(name).toBe('screenshot-embeddings');
    expect(typeof redisUrl).toBe('string');
    expect(opts).toEqual({
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  });

  it('memoizes: a second call reuses the same instance and constructor fires once', () => {
    const first = embeddingQueue.getEmbeddingQueue();
    const second = embeddingQueue.getEmbeddingQueue();

    expect(second).toBe(first);
    expect(MockQueue).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueEmbedding', () => {
  it('calls queue.add with screenshotId and s3Key', async () => {
    const queue = embeddingQueue.getEmbeddingQueue();

    await embeddingQueue.enqueueEmbedding('shot-1', 'screenshots/sys/2026-07-15/shot-1.png');

    expect(queue.add).toHaveBeenCalledWith({
      screenshotId: 'shot-1',
      s3Key: 'screenshots/sys/2026-07-15/shot-1.png',
    });
  });

  it('propagates a rejection from queue.add unchanged', async () => {
    const queue = embeddingQueue.getEmbeddingQueue();
    (queue.add as jest.Mock).mockRejectedValue(new Error('redis down'));

    await expect(embeddingQueue.enqueueEmbedding('shot-1', 'key')).rejects.toThrow('redis down');
  });

  it('reuses the lazily-constructed singleton across repeated calls', async () => {
    await embeddingQueue.enqueueEmbedding('a', 'k1');
    await embeddingQueue.enqueueEmbedding('b', 'k2');
    expect(MockQueue).toHaveBeenCalledTimes(1);
  });
});

describe('startWorker', () => {
  function setup(concurrency?: number) {
    const queue = embeddingQueue.getEmbeddingQueue();
    const db = {} as any;
    const embedder = {
      embedImage: jest.fn(),
      storeEmbedding: jest.fn(),
      markFailed: jest.fn(),
    };
    if (concurrency === undefined) {
      embeddingQueue.startWorker(db, embedder as any);
    } else {
      embeddingQueue.startWorker(db, embedder as any, concurrency);
    }
    const [registeredConcurrency, processor] = (queue.process as jest.Mock).mock.calls[0];
    return { queue, embedder, registeredConcurrency, processor };
  }

  it('registers a processor with default concurrency 4', () => {
    const { registeredConcurrency } = setup();
    expect(registeredConcurrency).toBe(4);
  });

  it('registers a processor with a custom concurrency', () => {
    const { registeredConcurrency } = setup(8);
    expect(registeredConcurrency).toBe(8);
  });

  it('happy path: downloads, embeds, stores, and cleans up the temp file', async () => {
    const { embedder, processor } = setup();
    downloadToTemp.mockResolvedValue('/tmp/shot-1.png');
    embedder.embedImage.mockResolvedValue([0.1, 0.2]);
    embedder.storeEmbedding.mockResolvedValue(undefined);

    await processor({ data: { screenshotId: 'shot-1', s3Key: 'k1' } });

    expect(downloadToTemp).toHaveBeenCalledWith('k1');
    expect(embedder.embedImage).toHaveBeenCalledWith('/tmp/shot-1.png');
    expect(embedder.storeEmbedding).toHaveBeenCalledWith('shot-1', [0.1, 0.2]);
    expect(embedder.markFailed).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith('/tmp/shot-1.png');
  });

  it('failure path: marks failed, re-throws so Bull retries, and still cleans up', async () => {
    const { embedder, processor } = setup();
    downloadToTemp.mockResolvedValue('/tmp/shot-1.png');
    embedder.embedImage.mockRejectedValue(new Error('bad image'));

    await expect(processor({ data: { screenshotId: 'shot-1', s3Key: 'k1' } })).rejects.toThrow('bad image');

    expect(embedder.markFailed).toHaveBeenCalledWith('shot-1', 'bad image');
    expect(unlink).toHaveBeenCalledWith('/tmp/shot-1.png');
  });

  it('handles a non-Error rejection via the String(err?.message ?? err) fallback', async () => {
    const { embedder, processor } = setup();
    downloadToTemp.mockResolvedValue('/tmp/shot-1.png');
    embedder.embedImage.mockRejectedValue('plain string failure');

    await expect(processor({ data: { screenshotId: 'shot-1', s3Key: 'k1' } })).rejects.toBe('plain string failure');

    expect(embedder.markFailed).toHaveBeenCalledWith('shot-1', 'plain string failure');
  });

  it('isolates a cleanup error: unlink rejecting does not break the happy path', async () => {
    const { embedder, processor } = setup();
    downloadToTemp.mockResolvedValue('/tmp/shot-1.png');
    embedder.embedImage.mockResolvedValue([0.1]);
    unlink.mockRejectedValueOnce(new Error('unlink failed'));

    await expect(processor({ data: { screenshotId: 'shot-1', s3Key: 'k1' } })).resolves.toBeUndefined();
  });

  it('does not attempt cleanup when downloadToTemp throws before localPath is assigned', async () => {
    const { embedder, processor } = setup();
    downloadToTemp.mockRejectedValue(new Error('s3 unreachable'));

    await expect(processor({ data: { screenshotId: 'shot-1', s3Key: 'k1' } })).rejects.toThrow('s3 unreachable');

    expect(embedder.markFailed).toHaveBeenCalledWith('shot-1', 's3 unreachable');
    expect(unlink).not.toHaveBeenCalled();
  });
});
