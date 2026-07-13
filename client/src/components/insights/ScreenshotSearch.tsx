import React, { useState } from 'react';
import { Search, X, Loader2, ImageOff } from 'lucide-react';
import { Card, CardContent } from '../ui/Card';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useToast } from '../../hooks/useToast';
import { useScreenshotImage } from '../../hooks/useScreenshotImage';
import { teveApi, TeveApiError } from '../../services/teveApi';
import { TeveSimilarScreenshot } from '../../types/teve';

const ScreenshotThumb: React.FC<{ id: string; alt: string }> = ({ id, alt }) => {
  const { url, failed } = useScreenshotImage(id);
  if (failed) {
    return (
      <div className="aspect-video w-full flex items-center justify-center bg-gray-100 text-gray-400">
        <ImageOff className="h-8 w-8" />
      </div>
    );
  }
  if (!url) {
    return <div className="aspect-video w-full bg-gray-100 animate-pulse" />;
  }
  return (
    <img src={url} alt={alt} loading="lazy" className="aspect-video w-full object-cover bg-gray-100" />
  );
};

const ResultGrid: React.FC<{
  results: TeveSimilarScreenshot[];
  onSelect: (id: string) => void;
}> = ({ results, onSelect }) => (
  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
    {results.map((r) => (
      <button
        key={r.screenshot.id}
        onClick={() => onSelect(r.screenshot.id)}
        className="text-left rounded-lg border border-gray-200 overflow-hidden hover:border-primary-400 hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-primary-500"
      >
        <ScreenshotThumb id={r.screenshot.id} alt={r.screenshot.scadaSystemId} />
        <div className="p-2.5 space-y-0.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-900">{r.screenshot.scadaSystemId}</span>
            <span className="text-xs font-mono text-primary-600">{(r.similarity * 100).toFixed(0)}%</span>
          </div>
          <p className="text-[11px] text-gray-500">
            {new Date(r.screenshot.timestamp).toLocaleString()}
          </p>
        </div>
      </button>
    ))}
  </div>
);

/** Text-to-image search over captured SCADA screenshots, plus click-through to similar screens. */
export const ScreenshotSearch: React.FC = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TeveSimilarScreenshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<{ kind: 'search'; query: string } | { kind: 'similar'; id: string } | null>(null);
  const { error: toastError } = useToast();

  const runSearch = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const r = await teveApi.searchScreenshots(q.trim(), 24);
      setResults(r);
      setMode({ kind: 'search', query: q.trim() });
    } catch (e) {
      toastError('Search failed', e instanceof TeveApiError ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const runSimilar = async (id: string) => {
    setLoading(true);
    try {
      const r = await teveApi.similarScreenshots(id, 12);
      setResults(r);
      setMode({ kind: 'similar', id });
    } catch (e) {
      toastError('Lookup failed', e instanceof TeveApiError ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form
            onSubmit={(e) => { e.preventDefault(); runSearch(query); }}
            className="flex gap-2"
          >
            <div className="flex-1">
              <Input
                placeholder="Describe what you're looking for, e.g. a red alarm banner on a boiler screen"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button type="submit" loading={loading}>
              <Search className="h-4 w-4 mr-2" />
              Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {mode?.kind === 'similar' && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600">Screens similar to the selected one</p>
          <Button variant="ghost" size="sm" onClick={() => { setResults([]); setMode(null); }}>
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {!loading && results.length === 0 && mode && (
        <p className="text-sm text-gray-500 py-8 text-center">No matching screens found.</p>
      )}

      {!loading && results.length > 0 && (
        <ResultGrid results={results} onSelect={runSimilar} />
      )}
    </div>
  );
};
