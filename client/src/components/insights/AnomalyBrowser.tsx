import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import { Card, CardContent } from '../ui/Card';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import { useToast } from '../../hooks/useToast';
import { teveApi, TeveApiError } from '../../services/teveApi';
import { TeveAnomaly, TeveSimilarAnomaly } from '../../types/teve';

const scoreColor = (score: number | null): string => {
  if (score === null) return 'bg-gray-100 text-gray-600';
  if (score >= 0.7) return 'bg-red-100 text-red-700';
  if (score >= 0.4) return 'bg-yellow-100 text-yellow-700';
  return 'bg-gray-100 text-gray-600';
};

const AnomalyRow: React.FC<{ anomaly: TeveAnomaly; similarity?: number; onClick?: () => void }> = ({
  anomaly, similarity, onClick,
}) => (
  <button
    onClick={onClick}
    disabled={!onClick}
    className={cn(
      'w-full flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200 text-left',
      onClick && 'hover:border-primary-400 hover:shadow-sm transition-all'
    )}
  >
    <div className="flex items-center gap-3 min-w-0">
      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">
          {anomaly.description || anomaly.type || 'Anomaly'}
        </p>
        <p className="text-xs text-gray-500">
          {new Date(anomaly.detectedAt).toLocaleString()}
          {anomaly.type && ` · ${anomaly.type}`}
        </p>
      </div>
    </div>
    <div className="flex items-center gap-2 shrink-0 ml-3">
      {typeof similarity === 'number' && (
        <span className="text-sm font-mono text-primary-600">{(similarity * 100).toFixed(0)}%</span>
      )}
      {anomaly.score !== null && (
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', scoreColor(anomaly.score))}>
          score {anomaly.score.toFixed(2)}
        </span>
      )}
    </div>
  </button>
);

/** Browse anomalies and, for any of them, look up similar past incidents by signature embedding. */
export const AnomalyBrowser: React.FC = () => {
  const [anomalies, setAnomalies] = useState<TeveAnomaly[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TeveAnomaly | null>(null);
  const [similar, setSimilar] = useState<TeveSimilarAnomaly[] | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);
  const { error: toastError } = useToast();

  const loadAnomalies = useCallback(async () => {
    setLoading(true);
    try {
      setAnomalies(await teveApi.anomalies(showResolved, 100));
    } catch (e) {
      toastError('Failed to load anomalies', e instanceof TeveApiError ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showResolved]);

  useEffect(() => { loadAnomalies(); }, [loadAnomalies]);

  const openSimilar = async (anomaly: TeveAnomaly) => {
    setSelected(anomaly);
    setSimilarLoading(true);
    try {
      setSimilar(await teveApi.similarAnomalies(anomaly.id, 10));
    } catch (e) {
      toastError('Lookup failed', e instanceof TeveApiError ? e.message : 'Unknown error');
      setSimilar([]);
    } finally {
      setSimilarLoading(false);
    }
  };

  if (selected) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setSimilar(null); }}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to anomalies
        </Button>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Reference incident</p>
            <AnomalyRow anomaly={selected} />
          </CardContent>
        </Card>
        <p className="text-sm text-gray-600">Similar past incidents</p>
        {similarLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : similar && similar.length === 0 ? (
          <p className="text-sm text-gray-500 py-8 text-center">
            No similar incidents found (or this anomaly has no embeddable metric window).
          </p>
        ) : (
          <div className="space-y-2">
            {similar?.map((s) => (
              <AnomalyRow key={s.anomaly.id} anomaly={s.anomaly} similarity={s.similarity} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant={showResolved ? 'outline' : 'primary'}
            size="sm"
            onClick={() => setShowResolved(false)}
          >
            Open
          </Button>
          <Button
            variant={showResolved ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setShowResolved(true)}
          >
            Resolved
          </Button>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
      </div>

      {!loading && anomalies.length === 0 && (
        <p className="text-sm text-gray-500 py-8 text-center">
          No {showResolved ? 'resolved' : 'open'} anomalies.
        </p>
      )}

      <div className="space-y-2">
        {anomalies.map((a) => (
          <AnomalyRow key={a.id} anomaly={a} onClick={() => openSimilar(a)} />
        ))}
      </div>
    </div>
  );
};
