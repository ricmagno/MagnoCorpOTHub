import { Pool } from 'pg';
import pino from 'pino';
import config from '../config';
import { embedTimeseriesWindow, TS_MODEL } from '../teve/extractors/timeseries';

const logger = pino();

export interface SimilarWindow {
  scada_system_id: string;
  tag_name: string;
  window_start: Date;
  window_end: Date;
  sample_count: number;
  distance: number;
  similarity: number;
}

/**
 * Computes and stores teve-ts-stat-v1 embeddings of metric windows, and runs
 * nearest-neighbour search over them. Windows are epoch-aligned slices of
 * config.teve.tsWindowMinutes.
 */
export class WindowEmbeddingService {
  constructor(private db: Pool) {}

  get windowMs(): number {
    return config.teve.tsWindowMinutes * 60_000;
  }

  /** Epoch-aligned start of the window containing `at`. */
  windowStartFor(at: Date): Date {
    return new Date(Math.floor(at.getTime() / this.windowMs) * this.windowMs);
  }

  /**
   * Embed one (system, tag, window) and upsert into metric_embeddings.
   * Returns stored=false when the window has too little data to embed.
   */
  async embedWindow(
    systemId: string,
    tagName: string,
    windowStart: Date
  ): Promise<{ stored: boolean; sampleCount: number }> {
    const windowEnd = new Date(windowStart.getTime() + this.windowMs);
    const res = await this.db.query(
      `SELECT time, tag_value FROM historian.metrics
       WHERE scada_system_id = $1 AND tag_name = $2 AND time >= $3 AND time < $4
       ORDER BY time ASC`,
      [systemId, tagName, windowStart, windowEnd]
    );
    const samples = res.rows.map((r: { time: Date; tag_value: unknown }) => ({
      time: r.time,
      value: Number(r.tag_value),
    }));
    const vec = embedTimeseriesWindow(samples);
    if (!vec) return { stored: false, sampleCount: samples.length };

    await this.db.query(
      `INSERT INTO historian.metric_embeddings
         (window_start, window_end, scada_system_id, tag_name, embedding, model, sample_count)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
       ON CONFLICT (window_start, scada_system_id, tag_name, model)
       DO UPDATE SET embedding = EXCLUDED.embedding,
                     window_end = EXCLUDED.window_end,
                     sample_count = EXCLUDED.sample_count,
                     created_at = NOW()`,
      [windowStart, windowEnd, systemId, tagName, `[${vec.join(',')}]`, TS_MODEL, samples.length]
    );
    return { stored: true, sampleCount: samples.length };
  }

  /** Embed the last completed window for every tag active in it. Returns windows stored. */
  async embedLastCompletedWindows(): Promise<number> {
    const currentStart = this.windowStartFor(new Date());
    const lastStart = new Date(currentStart.getTime() - this.windowMs);
    const tags = await this.db.query(
      `SELECT DISTINCT m.scada_system_id, m.tag_name
       FROM historian.metrics m
       JOIN historian.scada_systems s ON s.id = m.scada_system_id AND s.enabled
       WHERE m.time >= $1 AND m.time < $2`,
      [lastStart, currentStart]
    );
    let stored = 0;
    for (const t of tags.rows) {
      const r = await this.embedWindow(t.scada_system_id, t.tag_name, lastStart);
      if (r.stored) stored++;
    }
    logger.info({ windowStart: lastStart.toISOString(), tags: tags.rows.length, stored }, 'window embedding sweep');
    return stored;
  }

  /**
   * Nearest windows to the window containing `at` for the given tag. Embeds the
   * reference window on demand if it isn't stored yet. Returns null when the
   * reference window can't be embedded (no/insufficient data).
   */
  async findSimilarWindows(
    systemId: string,
    tagName: string,
    at: Date,
    limit = 10
  ): Promise<{ windowStart: Date; results: SimilarWindow[] } | null> {
    const windowStart = this.windowStartFor(at);
    const existing = await this.db.query(
      `SELECT 1 FROM historian.metric_embeddings
       WHERE scada_system_id = $1 AND tag_name = $2 AND window_start = $3 AND model = $4`,
      [systemId, tagName, windowStart, TS_MODEL]
    );
    if (existing.rows.length === 0) {
      const r = await this.embedWindow(systemId, tagName, windowStart);
      if (!r.stored) return null;
    }
    const result = await this.db.query(
      `WITH ref AS (
         SELECT embedding FROM historian.metric_embeddings
         WHERE scada_system_id = $1 AND tag_name = $2 AND window_start = $3 AND model = $4
       )
       SELECT m.scada_system_id, m.tag_name, m.window_start, m.window_end, m.sample_count,
              m.embedding <=> ref.embedding AS distance,
              1 - (m.embedding <=> ref.embedding) AS similarity
       FROM historian.metric_embeddings m, ref
       WHERE m.model = $4
         AND NOT (m.scada_system_id = $1 AND m.tag_name = $2 AND m.window_start = $3)
       ORDER BY distance ASC
       LIMIT $5`,
      [systemId, tagName, windowStart, TS_MODEL, limit]
    );
    return { windowStart, results: result.rows };
  }
}
