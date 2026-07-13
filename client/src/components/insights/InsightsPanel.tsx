import React, { useState } from 'react';
import { Search, TrendingUp, AlertTriangle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { ScreenshotSearch } from './ScreenshotSearch';
import { MetricWindowSearch } from './MetricWindowSearch';
import { AnomalyBrowser } from './AnomalyBrowser';

type InsightsSubTab = 'screens' | 'trends' | 'anomalies';

const SUB_TABS: { id: InsightsSubTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'screens', label: 'Screens', icon: Search },
  { id: 'trends', label: 'Trends', icon: TrendingUp },
  { id: 'anomalies', label: 'Anomalies', icon: AlertTriangle },
];

/**
 * TEVE (Tensor Embedding Vector Engine) search — text search over captured SCADA
 * screenshots, similar-shape lookup for metric windows, and similar-incident lookup
 * for anomalies. Talks to the separate Tensor Historian service (see teveApi.ts).
 */
export const InsightsPanel: React.FC = () => {
  const [subTab, setSubTab] = useState<InsightsSubTab>('screens');

  return (
    <div className="space-y-4">
      <div className="flex space-x-2 border-b border-gray-200">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={cn(
              'flex items-center px-4 py-2 border-b-2 font-medium text-sm transition-colors',
              subTab === tab.id
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            )}
          >
            <tab.icon className="h-4 w-4 mr-2" />
            {tab.label}
          </button>
        ))}
      </div>

      {subTab === 'screens' && <ScreenshotSearch />}
      {subTab === 'trends' && <MetricWindowSearch />}
      {subTab === 'anomalies' && <AnomalyBrowser />}
    </div>
  );
};
