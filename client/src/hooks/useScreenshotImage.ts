import { useEffect, useState } from 'react';
import { fetchScreenshotImageUrl } from '../services/teveApi';

/** Loads a screenshot's image as an authenticated blob URL; revokes it on unmount/id change. */
export function useScreenshotImage(id: string): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);

    fetchScreenshotImageUrl(id)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        objectUrl = u;
        setUrl(u);
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  return { url, failed };
}
