import React, { useState } from 'react';
import { Search, Loader2, TrendingUp } from 'lucide-react';
import { Card, CardContent } from '../ui/Card';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useToast } from '../../hooks/useToast';
import { teveApi, TeveApiError } from '../../services/teveApi';
import { TeveWindowResult } from '../../types/teve';

/**
 * Given a tag (System.TagName) and a timestamp, find the historical windows whose
 * shape most resembles the window containing that timestamp — e.g. "has this valve
 * behaved like this before, and when?"
 */
export const MetricWindowSearch: React.FC = () => {
  const [tag, setTag] = useState('');
  const [at, setAt] = useState('');
  const [results, setResults] = useState<TeveWindowResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const { error: toastError } = useToast();

  const run = async () => {
    if (!tag.includes('.')) {
      toastError('Invalid tag', 'Tag must be in the form System.TagName, e.g. HMI-01.Temperature');
      return;
    }
    if (!at) {
      toastError('Missing timestamp', 'Pick a date/time inside the window you want to compare');
      return;
    }
    setLoading(true);
    try {
      const r = await teveApi.similarMetricWindows(tag.trim(), new Date(at).toISOString(), 15);
      setResults(r);
    } catch (e) {
      toastError('Lookup failed', e instanceof TeveApiError ? e.message : 'Unknown error');
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form
            onSubmit={(e) => { e.preventDefault(); run(); }}
            className="flex flex-col md:flex-row gap-3 md:items-end"
          >
            <div className="flex-1">
              <Input
                label="Tag"
                placeholder="HMI-01.Temperature"
                className="font-mono"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <Input
                label="Point in time"
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </div>
            <Button type="submit" loading={loading}>
              <Search className="h-4 w-4 mr-2" />
              Find similar windows
            </Button>
          </form>
        </CardContent>
      </Card>

      {loading && (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {!loading && results && results.length === 0 && (
        <p className="text-sm text-gray-500 py-8 text-center">No similar windows found.</p>
      )}

      {!loading && results && results.length > 0 && (
        <div className="space-y-2">
          {results.map((r) => (
            <div
              key={`${r.scadaSystemId}.${r.tagName}.${r.windowStart}`}
              className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200"
            >
              <div className="flex items-center gap-3">
                <TrendingUp className="h-4 w-4 text-gray-400" />
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {r.scadaSystemId}.{r.tagName}
                  </p>
                  <p className="text-xs text-gray-500">
                    {new Date(r.windowStart).toLocaleString()} – {new Date(r.windowEnd).toLocaleTimeString()}
                    {' · '}{r.sampleCount} samples
                  </p>
                </div>
              </div>
              <span className="text-sm font-mono text-primary-600">
                {(r.similarity * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
