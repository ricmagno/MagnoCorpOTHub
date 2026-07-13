import { useEffect, useState } from 'react';
import { getAuthToken } from '../services/api';

/**
 * Whether the TEVE (Tensor Embedding Vector Engine) integration is configured and
 * enabled — a separate, optional service that most deployments won't have. Used to
 * decide whether the Insights tab should even appear; fails closed (hidden) on any
 * error.
 */
export function useTeveEnabled(isAuthenticated: boolean): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setEnabled(false);
      return;
    }
    const token = getAuthToken();
    fetch('/api/teve-config', { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((data) => setEnabled(!!data.enabled))
      .catch(() => setEnabled(false));
  }, [isAuthenticated]);

  return enabled;
}
