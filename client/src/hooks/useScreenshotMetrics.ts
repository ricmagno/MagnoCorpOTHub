import { useEffect, useState } from 'react';
import { teveApi } from '../services/teveApi';
import { TeveScreenshotMetric } from '../types/teve';

/** Loads the historized tag values correlated to a screenshot's capture time. */
export function useScreenshotMetrics(id: string): { metrics: TeveScreenshotMetric[]; loading: boolean } {
  const [metrics, setMetrics] = useState<TeveScreenshotMetric[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setMetrics([]);
    setLoading(true);

    teveApi
      .screenshotMetrics(id)
      .then((m) => { if (!cancelled) setMetrics(m); })
      .catch(() => { /* metrics are supplementary; missing values just hide the row */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [id]);

  return { metrics, loading };
}
