/**
 * Unit tests for ScreenshotCaptureService. Puppeteer, sharp, uuid, the S3 object
 * store, and the embedding queue are all mocked — these verify the capture
 * orchestration (order of calls, cleanup, error propagation), not real browser
 * rendering, image compression, or S3 I/O.
 */
jest.mock('puppeteer');
jest.mock('sharp');
jest.mock('uuid', () => ({ v4: jest.fn(() => 'fixed-uuid') }));
jest.mock('pino', () => jest.fn(() => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
})));
jest.mock('../../src/historian/services/object-store', () => ({
  uploadScreenshot: jest.fn(),
}));
jest.mock('../../src/historian/workers/embedding-queue', () => ({
  enqueueEmbedding: jest.fn(),
}));

import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { ScreenshotCaptureService } from '../../src/historian/services/screenshot-capture';
import { uploadScreenshot } from '../../src/historian/services/object-store';
import { enqueueEmbedding } from '../../src/historian/workers/embedding-queue';
import config from '../../src/historian/config';

const mockLaunch = puppeteer.launch as jest.Mock;
const mockSharp = sharp as unknown as jest.Mock;

const PNG_BYTES = Buffer.from('compressed-png');

function makePage(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    setViewport: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('raw-png')),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeBrowser(page = makePage()) {
  return {
    page,
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const mockQuery = jest.fn();
const db = { query: mockQuery } as any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockLaunch.mockResolvedValue(makeBrowser());
  mockSharp.mockReturnValue({
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(PNG_BYTES),
  });
  mockQuery.mockResolvedValue({ rows: [] });
  (uploadScreenshot as jest.Mock).mockResolvedValue(undefined);
  (enqueueEmbedding as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

async function runCapture(service: ScreenshotCaptureService, scadaSystemId = 'sys1', url = 'http://hmi/dash') {
  const promise = service.capture(scadaSystemId, url);
  // Attach a handler synchronously so Node never flags this as an unhandled
  // rejection while we advance fake timers past the render-wait sleep below.
  promise.catch(() => {});
  await jest.advanceTimersByTimeAsync(2000);
  return promise;
}

describe('init', () => {
  it('launches Puppeteer with the expected headless args', async () => {
    const service = new ScreenshotCaptureService(db);
    await service.init();
    expect(mockLaunch).toHaveBeenCalledWith({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  });
});

describe('capture', () => {
  it('lazily launches the browser on first call only', async () => {
    const service = new ScreenshotCaptureService(db);
    await runCapture(service);
    await runCapture(service);
    expect(mockLaunch).toHaveBeenCalledTimes(1);
  });

  it('sets the viewport and navigates with networkidle2/30s timeout', async () => {
    const page = makePage();
    mockLaunch.mockResolvedValue(makeBrowser(page));
    const service = new ScreenshotCaptureService(db);
    await runCapture(service, 'sys1', 'http://hmi/dash');

    expect(page.setViewport).toHaveBeenCalledWith({ width: 1920, height: 1080 });
    expect(page.goto).toHaveBeenCalledWith('http://hmi/dash', { waitUntil: 'networkidle2', timeout: 30_000 });
  });

  it('compresses the screenshot via sharp with compressionLevel 8', async () => {
    const service = new ScreenshotCaptureService(db);
    await runCapture(service);

    expect(mockSharp).toHaveBeenCalledWith(Buffer.from('raw-png'));
    const chain = mockSharp.mock.results[0].value;
    expect(chain.png).toHaveBeenCalledWith({ compressionLevel: 8 });
  });

  it('builds a date-partitioned S3 key from the fixed uuid', async () => {
    const service = new ScreenshotCaptureService(db);
    await runCapture(service, 'sys1');

    const [key] = (uploadScreenshot as jest.Mock).mock.calls[0];
    expect(key).toMatch(/^screenshots\/sys1\/\d{4}-\d{2}-\d{2}\/fixed-uuid\.png$/);
  });

  it('inserts a historian.screenshots row with the correct params', async () => {
    const service = new ScreenshotCaptureService(db);
    await runCapture(service, 'sys1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO historian\.screenshots/);
    expect(params[0]).toBe('fixed-uuid');
    expect(params[1]).toBe('sys1');
    expect(params[2]).toBeInstanceOf(Date);
    expect(params[3]).toBe(config.s3.bucket);
    expect(params[4]).toMatch(/^screenshots\/sys1\//);
    expect(params[5]).toBe(PNG_BYTES.length);
  });

  it('enqueues the embedding job after the DB insert', async () => {
    const service = new ScreenshotCaptureService(db);
    await runCapture(service, 'sys1');

    expect(enqueueEmbedding).toHaveBeenCalledWith('fixed-uuid', expect.stringMatching(/^screenshots\/sys1\//));
    const insertOrder = mockQuery.mock.invocationCallOrder[0];
    const enqueueOrder = (enqueueEmbedding as jest.Mock).mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(enqueueOrder);
  });

  it('resolves with the generated screenshot id', async () => {
    const service = new ScreenshotCaptureService(db);
    const id = await runCapture(service);
    expect(id).toBe('fixed-uuid');
  });

  it('always closes the page on success', async () => {
    const page = makePage();
    mockLaunch.mockResolvedValue(makeBrowser(page));
    const service = new ScreenshotCaptureService(db);
    await runCapture(service);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('closes the page and propagates the error when page.goto rejects', async () => {
    const page = makePage({ goto: jest.fn().mockRejectedValue(new Error('nav timeout')) });
    mockLaunch.mockResolvedValue(makeBrowser(page));
    const service = new ScreenshotCaptureService(db);

    await expect(runCapture(service)).rejects.toThrow('nav timeout');
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(uploadScreenshot).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it('closes the page and propagates the error when uploadScreenshot rejects', async () => {
    (uploadScreenshot as jest.Mock).mockRejectedValue(new Error('s3 unreachable'));
    const page = makePage();
    mockLaunch.mockResolvedValue(makeBrowser(page));
    const service = new ScreenshotCaptureService(db);

    await expect(runCapture(service)).rejects.toThrow('s3 unreachable');
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it('closes the page and propagates the error when the DB insert rejects', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const page = makePage();
    mockLaunch.mockResolvedValue(makeBrowser(page));
    const service = new ScreenshotCaptureService(db);

    await expect(runCapture(service)).rejects.toThrow('connection lost');
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it('leaves an inserted row with no queued embedding job when enqueueEmbedding rejects', async () => {
    (enqueueEmbedding as jest.Mock).mockRejectedValue(new Error('redis down'));
    const page = makePage();
    mockLaunch.mockResolvedValue(makeBrowser(page));
    const service = new ScreenshotCaptureService(db);

    await expect(runCapture(service)).rejects.toThrow('redis down');
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1); // the row was already inserted before the failure
  });
});

describe('shutdown', () => {
  it('closes the browser if one was launched', async () => {
    const browser = makeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const service = new ScreenshotCaptureService(db);
    await runCapture(service);
    await service.shutdown();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no browser was ever launched', async () => {
    const service = new ScreenshotCaptureService(db);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});
