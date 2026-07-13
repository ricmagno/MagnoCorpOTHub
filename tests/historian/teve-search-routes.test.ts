/**
 * Validation-path tests for the TEVE search routes. The engine and DB are mocked —
 * these verify the HTTP contract (400s, limit caps, param parsing), not retrieval
 * quality (that's scripts/historian/teve-eval.ts).
 */
import express from 'express';
import request from 'supertest';
import { createTeveSearchRouter } from '../../src/historian/routes/teve-search';

const mockQuery = jest.fn();
const db = { query: mockQuery } as any;

const engine = {
  embedText: jest.fn(async () => new Array(512).fill(0.1)),
} as any;

const windows = {
  findSimilarWindows: jest.fn(),
} as any;

const anomalies = {
  findSimilarAnomalies: jest.fn(),
} as any;

const app = express();
app.use('/api', createTeveSearchRouter(db, engine, windows, anomalies));

beforeEach(() => jest.clearAllMocks());

describe('GET /api/teve/search', () => {
  it('400s without q', async () => {
    const res = await request(app).get('/api/teve/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/q/);
    expect(engine.embedText).not.toHaveBeenCalled();
  });

  it('400s on whitespace-only q', async () => {
    const res = await request(app).get('/api/teve/search?q=%20%20');
    expect(res.status).toBe(400);
  });

  it('caps limit at 100 and defaults to 10', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await request(app).get('/api/teve/search?q=alarm&limit=5000');
    expect(mockQuery.mock.calls[0][1][1]).toBe(100);
    await request(app).get('/api/teve/search?q=alarm');
    expect(mockQuery.mock.calls[1][1][1]).toBe(10);
  });

  it('returns ranked results', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'a', distance: 0.7, similarity: 0.3 }] });
    const res = await request(app).get('/api/teve/search?q=red%20alarm');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ query: 'red alarm', count: 1 });
  });

  it('500s with the error message when the engine fails', async () => {
    engine.embedText.mockRejectedValueOnce(new Error('model not available'));
    const res = await request(app).get('/api/teve/search?q=x');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/model not available/);
  });
});

describe('GET /api/teve/windows/similar', () => {
  it('400s on malformed tag', async () => {
    for (const tag of ['NoDot', '.LeadingDot', 'TrailingDot.', '']) {
      const res = await request(app).get(`/api/teve/windows/similar?tag=${tag}&at=2026-07-08T10:00:00Z`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/System\.TagName/);
    }
  });

  it('400s on unparseable at', async () => {
    const res = await request(app).get('/api/teve/windows/similar?tag=HMI-01.Temp&at=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at/);
  });

  it('404s when the reference window cannot be embedded', async () => {
    windows.findSimilarWindows.mockResolvedValue(null);
    const res = await request(app).get('/api/teve/windows/similar?tag=HMI-01.Temp&at=2026-07-08T10:00:00Z');
    expect(res.status).toBe(404);
  });

  it('passes parsed tag parts and capped limit to the service', async () => {
    windows.findSimilarWindows.mockResolvedValue({ windowStart: new Date(0), results: [] });
    await request(app).get('/api/teve/windows/similar?tag=HMI-01.Temp.Outer&at=2026-07-08T10:00:00Z&limit=999');
    expect(windows.findSimilarWindows).toHaveBeenCalledWith('HMI-01', 'Temp.Outer', expect.any(Date), 100);
  });
});

describe('GET /api/teve/anomalies/:id/similar', () => {
  it('404s for an unknown or unembeddable anomaly', async () => {
    anomalies.findSimilarAnomalies.mockResolvedValue(null);
    const res = await request(app).get('/api/teve/anomalies/nope/similar');
    expect(res.status).toBe(404);
  });

  it('returns results with capped limit', async () => {
    anomalies.findSimilarAnomalies.mockResolvedValue([]);
    const res = await request(app).get('/api/teve/anomalies/abc/similar?limit=101');
    expect(res.status).toBe(200);
    expect(anomalies.findSimilarAnomalies).toHaveBeenCalledWith('abc', 100);
  });
});
