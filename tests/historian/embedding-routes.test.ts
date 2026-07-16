/**
 * Validation-path tests for the screenshot embedding routes. The DB, embedder, and
 * capture service are mocked — these verify the HTTP contract (404s/400s/500s,
 * limit caps, param parsing), not real capture/embedding behavior.
 */
import express from 'express';
import request from 'supertest';
import { createEmbeddingRouter } from '../../src/historian/routes/embedding-routes';

jest.mock('../../src/historian/services/object-store', () => ({
  downloadBuffer: jest.fn(),
}));
import { downloadBuffer } from '../../src/historian/services/object-store';

const mockQuery = jest.fn();
const db = { query: mockQuery } as any;

const embedder = {
  findSimilar: jest.fn(),
} as any;

const capture = {
  capture: jest.fn(),
} as any;

const app = express();
app.use(express.json());
app.use('/api', createEmbeddingRouter(db, embedder, capture));

beforeEach(() => jest.clearAllMocks());

describe('GET /api/screenshots/:id/image', () => {
  it('404s when the screenshot has no s3_key', async () => {
    mockQuery.mockResolvedValue({ rows: [{}] });
    const res = await request(app).get('/api/screenshots/shot-1/image');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'screenshot not found' });
    expect(downloadBuffer).not.toHaveBeenCalled();
  });

  it('404s when no row is found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/screenshots/missing/image');
    expect(res.status).toBe(404);
  });

  it('200s with the image content type, immutable cache header, and buffer on success', async () => {
    mockQuery.mockResolvedValue({ rows: [{ s3_key: 'screenshots/sys1/2026-07-15/shot-1.png' }] });
    (downloadBuffer as jest.Mock).mockResolvedValue(Buffer.from('png-bytes'));

    const res = await request(app).get('/api/screenshots/shot-1/image');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toMatch(/immutable/);
    expect(Buffer.compare(res.body, Buffer.from('png-bytes'))).toBe(0);
    expect(downloadBuffer).toHaveBeenCalledWith('screenshots/sys1/2026-07-15/shot-1.png');
  });

  it('500s with the error message when the DB lookup throws', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const res = await request(app).get('/api/screenshots/shot-1/image');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/connection lost/);
  });

  it('500s with the error message when downloadBuffer throws', async () => {
    mockQuery.mockResolvedValue({ rows: [{ s3_key: 'k1' }] });
    (downloadBuffer as jest.Mock).mockRejectedValue(new Error('s3 unreachable'));
    const res = await request(app).get('/api/screenshots/shot-1/image');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/s3 unreachable/);
  });
});

describe('POST /api/screenshots', () => {
  it('400s when scada_system_id is missing', async () => {
    const res = await request(app).post('/api/screenshots').send({ url: 'http://hmi/dash' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'scada_system_id and url required' });
    expect(capture.capture).not.toHaveBeenCalled();
  });

  it('400s when url is missing', async () => {
    const res = await request(app).post('/api/screenshots').send({ scada_system_id: 'sys1' });
    expect(res.status).toBe(400);
    expect(capture.capture).not.toHaveBeenCalled();
  });

  it('400s on an empty body', async () => {
    const res = await request(app).post('/api/screenshots').send({});
    expect(res.status).toBe(400);
  });

  it('202s with screenshot_id and queued status on success', async () => {
    capture.capture.mockResolvedValue('shot-1');
    const res = await request(app).post('/api/screenshots').send({ scada_system_id: 'sys1', url: 'http://hmi/dash' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ screenshot_id: 'shot-1', status: 'queued' });
    expect(capture.capture).toHaveBeenCalledWith('sys1', 'http://hmi/dash');
  });

  it('500s with the error message when capture.capture throws', async () => {
    capture.capture.mockRejectedValue(new Error('puppeteer crashed'));
    const res = await request(app).post('/api/screenshots').send({ scada_system_id: 'sys1', url: 'http://hmi/dash' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/puppeteer crashed/);
  });
});

describe('GET /api/screenshots/:id/similar', () => {
  it('defaults to limit=10 and max_distance=0.3 when omitted', async () => {
    embedder.findSimilar.mockResolvedValue([]);
    await request(app).get('/api/screenshots/shot-1/similar');
    expect(embedder.findSimilar).toHaveBeenCalledWith('shot-1', 10, 0.3);
  });

  it('caps limit at 100', async () => {
    embedder.findSimilar.mockResolvedValue([]);
    await request(app).get('/api/screenshots/shot-1/similar?limit=5000');
    expect(embedder.findSimilar).toHaveBeenCalledWith('shot-1', 100, 0.3);
  });

  it('passes a custom limit under the cap through unchanged', async () => {
    embedder.findSimilar.mockResolvedValue([]);
    await request(app).get('/api/screenshots/shot-1/similar?limit=25');
    expect(embedder.findSimilar).toHaveBeenCalledWith('shot-1', 25, 0.3);
  });

  it('parses a custom max_distance', async () => {
    embedder.findSimilar.mockResolvedValue([]);
    await request(app).get('/api/screenshots/shot-1/similar?max_distance=0.5');
    expect(embedder.findSimilar).toHaveBeenCalledWith('shot-1', 10, 0.5);
  });

  it('returns the response shape from findSimilar results', async () => {
    const rows = [{ id: 'a', distance: 0.1, similarity: 0.9 }];
    embedder.findSimilar.mockResolvedValue(rows);
    const res = await request(app).get('/api/screenshots/shot-1/similar');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screenshot_id: 'shot-1', count: 1, results: rows });
  });

  it('500s with the error message when findSimilar throws', async () => {
    embedder.findSimilar.mockRejectedValue(new Error('query failed'));
    const res = await request(app).get('/api/screenshots/shot-1/similar');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/query failed/);
  });

  it('documents current behavior: a non-numeric limit passes through as NaN', async () => {
    embedder.findSimilar.mockResolvedValue([]);
    await request(app).get('/api/screenshots/shot-1/similar?limit=abc');
    expect(embedder.findSimilar).toHaveBeenCalledWith('shot-1', NaN, 0.3);
  });
});
