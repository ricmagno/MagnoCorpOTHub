/**
 * Unit tests for ScreenshotEmbedder. The DB and ImageExtractor are mocked — these
 * verify query shapes and delegation, not CLIP model correctness (that's
 * scripts/historian/teve-eval.ts).
 */
import { ScreenshotEmbedder } from '../../src/historian/services/screenshot-embedder';

const mockQuery = jest.fn();
const db = { query: mockQuery } as any;

const extractor = {
  initialize: jest.fn(),
  embed: jest.fn(),
} as any;

beforeEach(() => jest.clearAllMocks());

describe('initialize', () => {
  it('delegates to extractor.initialize()', async () => {
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.initialize();
    expect(extractor.initialize).toHaveBeenCalledTimes(1);
    expect(extractor.initialize).toHaveBeenCalledWith();
  });
});

describe('embedImage', () => {
  it('delegates to extractor.embed() and returns its result', async () => {
    extractor.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    const embedder = new ScreenshotEmbedder(db, extractor);
    const result = await embedder.embedImage('/tmp/fake.png');
    expect(extractor.embed).toHaveBeenCalledWith('/tmp/fake.png');
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('propagates a rejection from extractor.embed unchanged', async () => {
    extractor.embed.mockRejectedValue(new Error('model unavailable'));
    const embedder = new ScreenshotEmbedder(db, extractor);
    await expect(embedder.embedImage('/tmp/fake.png')).rejects.toThrow('model unavailable');
  });
});

describe('storeEmbedding', () => {
  it('builds the pgvector literal string and sets processed status', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.storeEmbedding('shot-1', [0.1, 0.2, 0.3]);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/processing_status = 'processed'/);
    expect(sql).toMatch(/embedding = \$1::vector/);
    expect(params).toEqual(['[0.1,0.2,0.3]', 'shot-1']);
  });

  it('handles an empty embedding array', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.storeEmbedding('shot-1', []);
    expect(mockQuery.mock.calls[0][1]).toEqual(['[]', 'shot-1']);
  });

  it('propagates a rejection from db.query unchanged', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const embedder = new ScreenshotEmbedder(db, extractor);
    await expect(embedder.storeEmbedding('shot-1', [0.1])).rejects.toThrow('connection lost');
  });
});

describe('markFailed', () => {
  it('passes screenshotId and error in order', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.markFailed('shot-1', 'boom');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/processing_status = 'failed'/);
    expect(params).toEqual(['shot-1', 'boom']);
  });

  it('truncates an error longer than 1000 chars', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    const longErr = 'x'.repeat(2000);
    await embedder.markFailed('shot-1', longErr);

    const params = mockQuery.mock.calls[0][1];
    expect(params[1]).toHaveLength(1000);
    expect(params[1]).toBe('x'.repeat(1000));
  });

  it('passes a short error string through unchanged', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.markFailed('shot-1', 'short');
    expect(mockQuery.mock.calls[0][1][1]).toBe('short');
  });

  it('propagates a rejection from db.query unchanged', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const embedder = new ScreenshotEmbedder(db, extractor);
    await expect(embedder.markFailed('shot-1', 'err')).rejects.toThrow('connection lost');
  });
});

describe('findSimilar', () => {
  it('uses default limit and maxDistance when omitted', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.findSimilar('shot-1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['shot-1', 0.3, 10]);
  });

  it('passes custom limit and maxDistance through as query params', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    await embedder.findSimilar('shot-1', 25, 0.5);
    expect(mockQuery.mock.calls[0][1]).toEqual(['shot-1', 0.5, 25]);
  });

  it('returns result.rows unchanged for a populated result set', async () => {
    const rows = [
      { id: 'a', timestamp: new Date(0), scada_system_id: 'sys1', s3_key: 'k1', distance: 0.1, similarity: 0.9 },
    ];
    mockQuery.mockResolvedValue({ rows });
    const embedder = new ScreenshotEmbedder(db, extractor);
    const result = await embedder.findSimilar('shot-1');
    expect(result).toBe(rows);
  });

  it('returns an empty array when result.rows is empty', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const embedder = new ScreenshotEmbedder(db, extractor);
    const result = await embedder.findSimilar('shot-1');
    expect(result).toEqual([]);
  });

  it('propagates a rejection from db.query unchanged', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const embedder = new ScreenshotEmbedder(db, extractor);
    await expect(embedder.findSimilar('shot-1')).rejects.toThrow('connection lost');
  });
});
