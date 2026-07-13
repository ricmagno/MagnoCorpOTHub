/**
 * Type definitions for the Tensor Historian's TEVE (Tensor Embedding Vector Engine) —
 * a separate service from the main AVEVA Historian integration (see types/historian.ts).
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
