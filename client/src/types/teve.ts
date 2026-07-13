/**
 * Type definitions for TEVE (Tensor Embedding Vector Engine) — a separate, optional
 * service that stores historized time-series data alongside vector embeddings (of
 * screenshots, metric windows, and anomaly signatures) for similarity search. Distinct
 * from the main AVEVA Historian integration (see types/historian.ts).
 */

export interface TeveScreenshot {
  id: string;
  timestamp: string;
  scadaSystemId: string;
  s3Key: string;
  processingStatus: string;
}

export interface TeveSimilarScreenshot {
  screenshot: TeveScreenshot;
  similarity: number;
  distance: number;
}

export interface TeveWindowResult {
  scadaSystemId: string;
  tagName: string;
  windowStart: string;
  windowEnd: string;
  sampleCount: number;
  similarity: number;
  distance: number;
}

export interface TeveAnomaly {
  id: string;
  detectedAt: string;
  type: string | null;
  score: number | null;
  description: string | null;
  resolved: boolean;
}

export interface TeveSimilarAnomaly {
  anomaly: TeveAnomaly;
  similarity: number;
  distance: number;
}
