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
    if (!this.browser) await this.init();
    const page = await this.browser!.newPage();
    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
      await sleep(2000); // let SCADA widgets render

      const raw = await page.screenshot({ type: 'png' });
      const png = await sharp(raw).png({ compressionLevel: 8 }).toBuffer();

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
      logger.info({ id, scadaSystemId }, 'captured, uploaded, queued');
      return id;
    } finally {
      await page.close();
    }
  }

  async shutdown(): Promise<void> {
    await this.browser?.close();
  }
}
