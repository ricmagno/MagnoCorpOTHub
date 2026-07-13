import pino from 'pino';
import config from '../../config';

const logger = pino();

/**
 * CLIP text extractor. Produces 512-D vectors in the SAME joint space as the image
 * extractor, enabling text→screenshot search.
 *
 * IMPORTANT: unlike the image pipeline, CLIPTextModelWithProjection's text_embeds are
 * NOT normalized (measured L2 norm ≈9.5) — we must L2-normalize here or cosine
 * distances against the normalized image vectors are meaningless.
 */
export class TextExtractor {
  readonly modality = 'text' as const;
  readonly model = config.embedding.model;
  readonly dimension = config.embedding.dimension;
  private tokenizer: any = null;
  private textModel: any = null;
  private loading: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.textModel) return;
    if (!this.loading) {
      this.loading = (async () => {
        const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import('@xenova/transformers');
        env.cacheDir = config.embedding.cacheDir;
        env.allowRemoteModels = config.embedding.allowRemoteModels;
        logger.info({ model: this.model }, 'loading CLIP text model');
        this.tokenizer = await AutoTokenizer.from_pretrained(this.model);
        this.textModel = await CLIPTextModelWithProjection.from_pretrained(this.model);
        logger.info('CLIP text model ready');
      })();
    }
    await this.loading;
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize();
    const inputs = this.tokenizer([text], { padding: true, truncation: true });
    const { text_embeds } = await this.textModel(inputs);
    const raw: number[] = Array.from(text_embeds.data as Float32Array);
    if (raw.length !== this.dimension) {
      throw new Error(`text extractor returned ${raw.length}-D, schema expects ${this.dimension}-D`);
    }
    let sum = 0;
    for (const v of raw) sum += v * v;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm < 1e-12) {
      throw new Error('text extractor produced a zero/non-finite vector');
    }
    return raw.map((v) => v / norm);
  }
}
