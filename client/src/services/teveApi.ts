/**
 * Client for TEVE (Tensor Embedding Vector Engine). Requests go through the main
 * backend's proxy (src/routes/teveProxy.ts), same-origin, same auth as every other
 * /api/* call — the backend forwards to wherever TEVE is actually deployed (a
 * separate, optional service in its own container, admin-configured; see
 * TeveConfiguration.tsx). The browser never talks to TEVE directly.
 */
import { getAuthToken } from './api';
import {
  TeveSimilarScreenshot,
  TeveWindowResult,
  TeveAnomaly,
  TeveSimilarAnomaly,
  TeveScreenshotMetric,
} from '../types/teve';

class TeveApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'TeveApiError';
  }
}

async function authedFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers } });
  if (res.status === 503) {
    throw new TeveApiError('TEVE is not configured or is disabled', 503);
  }
  return res;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await authedFetch('/api/teve-graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new TeveApiError(body.errors[0].message);
  }
  if (!res.ok) {
    throw new TeveApiError(`HTTP ${res.status}`, res.status);
  }
  return body.data;
}

/**
 * Fetches a screenshot's image bytes (auth required, so this can't just be a plain
 * <img src="..."> URL — browsers don't attach custom headers to image requests) and
 * returns an object URL. Caller must revokeObjectURL when done (see useScreenshotImage).
 */
export async function fetchScreenshotImageUrl(id: string): Promise<string> {
  const res = await authedFetch(`/api/historian/screenshots/${encodeURIComponent(id)}/image`);
  if (!res.ok) throw new TeveApiError(`Failed to load image (${res.status})`, res.status);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export const teveApi = {
  async searchScreenshots(query: string, limit = 20): Promise<TeveSimilarScreenshot[]> {
    const data = await graphql<{ searchScreenshots: TeveSimilarScreenshot[] }>(
      `query($query: String!, $limit: Int) {
        searchScreenshots(query: $query, limit: $limit) {
          similarity distance
          screenshot { id timestamp scadaSystemId s3Key processingStatus }
        }
      }`,
      { query, limit }
    );
    return data.searchScreenshots;
  },

  async similarScreenshots(screenshotId: string, limit = 12): Promise<TeveSimilarScreenshot[]> {
    const data = await graphql<{ similarScreenshots: TeveSimilarScreenshot[] }>(
      `query($screenshotId: ID!, $limit: Int) {
        similarScreenshots(screenshotId: $screenshotId, limit: $limit) {
          similarity distance
          screenshot { id timestamp scadaSystemId s3Key processingStatus }
        }
      }`,
      { screenshotId, limit }
    );
    return data.similarScreenshots;
  },

  /** Historized tag values nearest to the screenshot's capture time (joined by time, not system). */
  async screenshotMetrics(screenshotId: string, toleranceS = 300): Promise<TeveScreenshotMetric[]> {
    const res = await authedFetch(
      `/api/historian/screenshots/${encodeURIComponent(screenshotId)}/metrics?tolerance_s=${toleranceS}`
    );
    if (!res.ok) throw new TeveApiError(`Failed to load metrics (${res.status})`, res.status);
    const body = await res.json();
    return body.metrics ?? [];
  },

  async similarMetricWindows(tag: string, at: string, limit = 10): Promise<TeveWindowResult[]> {
    const data = await graphql<{ similarMetricWindows: TeveWindowResult[] }>(
      `query($tag: String!, $at: String!, $limit: Int) {
        similarMetricWindows(tag: $tag, at: $at, limit: $limit) {
          scadaSystemId tagName windowStart windowEnd sampleCount similarity distance
        }
      }`,
      { tag, at, limit }
    );
    return data.similarMetricWindows;
  },

  async anomalies(resolved = false, limit = 50): Promise<TeveAnomaly[]> {
    const data = await graphql<{ anomalies: TeveAnomaly[] }>(
      `query($resolved: Boolean, $limit: Int) {
        anomalies(resolved: $resolved, limit: $limit) {
          id detectedAt type score description resolved
        }
      }`,
      { resolved, limit }
    );
    return data.anomalies;
  },

  async similarAnomalies(anomalyId: string, limit = 10): Promise<TeveSimilarAnomaly[]> {
    const data = await graphql<{ similarAnomalies: TeveSimilarAnomaly[] }>(
      `query($anomalyId: ID!, $limit: Int) {
        similarAnomalies(anomalyId: $anomalyId, limit: $limit) {
          similarity distance
          anomaly { id detectedAt type score description resolved }
        }
      }`,
      { anomalyId, limit }
    );
    return data.similarAnomalies;
  },
};

export { TeveApiError };
