import { Pool } from 'pg';
import { ImageExtractor } from '../teve/extractors/image';

export class ScreenshotEmbedder {
  private extractor: ImageExtractor;

  constructor(private db: Pool, extractor?: ImageExtractor) {
    // Delegates to the TEVE image extractor so the worker and any TeveEngine instance
    // can share one loaded CLIP vision model.
    this.extractor = extractor ?? new ImageExtractor();
  }

  async initialize(): Promise<void> {
    await this.extractor.initialize();
  }

  /** Returns L2-normalized 512-D image embedding */
  async embedImage(localPath: string): Promise<number[]> {
    return this.extractor.embed(localPath);
  }

  async storeEmbedding(screenshotId: string, embedding: number[]): Promise<void> {
    await this.db.query(
      `UPDATE historian.screenshots
         SET embedding = $1::vector,
             embedding_generated_at = NOW(),
             processing_status = 'processed'
       WHERE id = $2`,
      [`[${embedding.join(',')}]`, screenshotId]
    );
  }

  async markFailed(screenshotId: string, err: string): Promise<void> {
    await this.db.query(
      `UPDATE historian.screenshots
         SET processing_status = 'failed', processing_error = $2
       WHERE id = $1`,
      [screenshotId, err.slice(0, 1000)]
    );
  }

  /**
   * Cosine distance search. <=> is pgvector's cosine-distance operator
   * (range 0..2); similarity = 1 - distance. Lower distance = more similar.
   */
  async findSimilar(screenshotId: string, limit = 10, maxDistance = 0.3) {
    const result = await this.db.query(
      `WITH ref AS (
         SELECT embedding FROM historian.screenshots
         WHERE id = $1 AND embedding IS NOT NULL
       )
       SELECT s.id, s.timestamp, s.scada_system_id, s.s3_key,
              s.embedding <=> ref.embedding AS distance,
              1 - (s.embedding <=> ref.embedding) AS similarity
       FROM historian.screenshots s, ref
       WHERE s.id != $1
         AND s.embedding IS NOT NULL
         AND s.embedding <=> ref.embedding < $2
       ORDER BY distance ASC
       LIMIT $3`,
      [screenshotId, maxDistance, limit]
    );
    return result.rows;
  }
}
