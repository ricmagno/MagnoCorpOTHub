/**
 * TEVE — Tensor Embedding Vector Engine.
 *
 * One registry over the three extractors (image, text, timeseries). Image and text
 * share CLIP's 512-D joint space, which is what makes text→screenshot search work;
 * timeseries lives in its own 64-D space (teve-ts-stat-v1). Every extractor returns
 * L2-normalized vectors so pgvector's cosine-distance operator (<=>) behaves uniformly.
 */
import { ImageExtractor } from './extractors/image';
import { TextExtractor } from './extractors/text';
import {
  embedTimeseriesWindow,
  TS_MODEL,
  TS_DIMENSION,
  WindowSample,
} from './extractors/timeseries';

export function l2Normalize(vec: number[]): number[] | null {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm < 1e-12) return null;
  return vec.map((v) => v / norm);
}

export function assertDimension(vec: number[], expected: number, label: string): void {
  if (vec.length !== expected) {
    throw new Error(`${label} returned ${vec.length}-D, expected ${expected}-D`);
  }
}

/** Parse a TEVE tag id ("System.TagName") into its parts; null if malformed. */
export function parseTagId(tag: string): { systemId: string; tagName: string } | null {
  const dot = tag.indexOf('.');
  if (dot <= 0 || dot === tag.length - 1) return null;
  return { systemId: tag.slice(0, dot), tagName: tag.slice(dot + 1) };
}

export class TeveEngine {
  readonly image = new ImageExtractor();
  readonly text = new TextExtractor();
  readonly timeseries = { model: TS_MODEL, dimension: TS_DIMENSION } as const;

  /** 512-D CLIP image embedding of a local image file (loads vision model on first call). */
  embedImage(localPath: string): Promise<number[]> {
    return this.image.embed(localPath);
  }

  /** 512-D CLIP text embedding, same space as images (loads text model on first call). */
  embedText(query: string): Promise<number[]> {
    return this.text.embed(query);
  }

  /** 64-D deterministic time-series window embedding; null if the window has too little data. */
  embedTimeseries(samples: WindowSample[]): number[] | null {
    return embedTimeseriesWindow(samples);
  }
}

export { TS_MODEL, TS_DIMENSION };
export type { WindowSample };
