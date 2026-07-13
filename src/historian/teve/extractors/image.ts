import pino from 'pino';
import config from '../../config';

const logger = pino();

/**
 * CLIP image extractor (Xenova/clip-vit-base-patch16 by default). The
 * image-feature-extraction pipeline outputs the *projected* 512-D image embedding,
 * already L2-normalized via `{ normalize: true }`.
 */
export class ImageExtractor {
  readonly modality = 'image' as const;
  readonly model = config.embedding.model;
  readonly dimension = config.embedding.dimension;
  private extractor: any = null;
  private loading: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.extractor) return;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline, env } = await import('@xenova/transformers');
        env.cacheDir = config.embedding.cacheDir;
        env.allowRemoteModels = config.embedding.allowRemoteModels;
        logger.info(
          { model: this.model, cacheDir: config.embedding.cacheDir, allowRemoteModels: config.embedding.allowRemoteModels },
          'loading CLIP vision model'
        );
        this.extractor = await pipeline('image-feature-extraction', this.model);
        logger.info('CLIP vision model ready');
      })();
    }
    await this.loading;
  }

  async embed(localPath: string): Promise<number[]> {
    await this.initialize();
    const output = await this.extractor(localPath, { pooling: 'mean', normalize: true });
    const raw: number[] = Array.from(output.data as Float32Array);
    if (raw.length !== this.dimension) {
      throw new Error(`image extractor returned ${raw.length}-D, schema expects ${this.dimension}-D`);
    }
    // Despite `normalize: true`, measured output norms are not 1 for this model
    // (normalization applies before pooling). pgvector's <=> is norm-independent so
    // search still worked, but we normalize explicitly so dot products are true cosines.
    let sum = 0;
    for (const v of raw) sum += v * v;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm < 1e-12) {
      throw new Error('image extractor produced a zero/non-finite vector');
    }
    return raw.map((v) => v / norm);
  }
}
