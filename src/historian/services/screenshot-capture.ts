import puppeteer, { Browser } from 'puppeteer';
import sharp from 'sharp';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { uploadScreenshot } from './object-store';
import { enqueueEmbedding } from '../workers/embedding-queue';
import config from '../config';

const logger = pino();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ScreenshotCaptureService {
  private browser: Browser | null = null;
  constructor(private db: Pool) {}

  async init(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }

  async capture(scadaSystemId: string, url: string): Promise<string> {
    const sys = await this.db.query(
      `SELECT capture_method, capture_settle_ms
         FROM historian.scada_systems WHERE id = $1`,
      [scadaSystemId]
    );
    const system = sys.rows[0];
    if (!system) {
      throw new Error(`unknown scada_system_id: ${scadaSystemId}`);
    }
    if (system.capture_method !== 'web') {
      throw new Error(
        `scada system ${scadaSystemId} has capture_method '${system.capture_method}'; this service only handles 'web'`
      );
    }
    const settleMs: number = system.capture_settle_ms ?? 2000;

    if (!this.browser) await this.init();
    const page = await this.browser!.newPage();
    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
      await sleep(settleMs); // let SCADA widgets render

      const raw = await page.screenshot({ type: 'png' });
      const png = await sharp(raw).png({ compressionLevel: 8 }).toBuffer();
      return this.ingest(scadaSystemId, png);
    } finally {
      await page.close();
    }
  }

  /**
   * Store an already-rendered PNG and queue it for embedding. Shared by the web
   * driver above and the os-agent upload path (agents on thick-client SCADA nodes
   * POST their screen grabs here via /screenshots/upload).
   */
  async ingest(scadaSystemId: string, png: Buffer): Promise<string> {
    const id = uuidv4();
    const ts = new Date();
    const s3Key = `screenshots/${scadaSystemId}/${ts.toISOString().slice(0, 10)}/${id}.png`;

    await uploadScreenshot(s3Key, png);

    await this.db.query(
      `INSERT INTO historian.screenshots
         (id, scada_system_id, timestamp, s3_bucket, s3_key, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, scadaSystemId, ts, config.s3.bucket, s3Key, png.length]
    );

    await enqueueEmbedding(id, s3Key);
    logger.info({ id, scadaSystemId }, 'stored, uploaded, queued');
    return id;
  }

  async shutdown(): Promise<void> {
    await this.browser?.close();
  }
}
