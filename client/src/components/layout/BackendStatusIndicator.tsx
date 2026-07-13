import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Database, Radio, Boxes, ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

type ServiceStatus = 'healthy' | 'unhealthy' | 'not_configured' | 'disabled';

interface ServiceHealth {
  configured: boolean;
  status: ServiceStatus;
  detail?: string;
}

interface ServicesHealthResponse {
  status: 'healthy' | 'degraded';
  services: {
    historian: ServiceHealth;
    opcua: ServiceHealth;
    tensor: ServiceHealth;
  };
  serverTime?: { local: string; timezone: string };
}

const SERVICE_META: Record<keyof ServicesHealthResponse['services'], { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  historian: { label: 'AVEVA Historian', icon: Database },
  opcua: { label: 'OPC UA', icon: Radio },
  tensor: { label: 'TEVE', icon: Boxes }
};

// Shown as a tooltip on the TEVE row in the dropdown, since the acronym alone means
// nothing to a first-time viewer.
const SERVICE_TOOLTIP: Partial<Record<keyof ServicesHealthResponse['services'], string>> = {
  tensor: 'TEVE (Tensor Embedding Vector Engine) — historian with vector-embedding similarity search'
};

const STATUS_META: Record<ServiceStatus, { label: string; dot: string; text: string }> = {
  healthy: { label: 'Connected', dot: 'bg-green-500', text: 'text-green-700' },
  unhealthy: { label: 'Connection failed', dot: 'bg-red-500', text: 'text-red-700' },
  not_configured: { label: 'Not configured', dot: 'bg-gray-300', text: 'text-gray-500' },
  disabled: { label: 'Disabled', dot: 'bg-gray-300', text: 'text-gray-500' }
};

/**
 * Replaces the old AVEVA-Historian-only header pill: this app now integrates with
 * three independently-configurable data sources (AVEVA Historian, OPC UA, TEVE — the
 * Tensor Embedding Vector Engine), each optional. The aggregate pill summarizes
 * overall backend health; the dropdown breaks it down per service so "degraded"
 * doesn't read as ambiguous.
 */
export const BackendStatusIndicator: React.FC = () => {
  const [data, setData] = useState<ServicesHealthResponse | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`${process.env.REACT_APP_API_URL || '/api'}/health/services`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        setReachable(false);
        return;
      }
      const body = await response.json() as ServicesHealthResponse;
      setData(body);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const intervalId = setInterval(checkHealth, 5000);
    return () => clearInterval(intervalId);
  }, [checkHealth]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  let pillLabel: string;
  let pillClass: string;

  if (reachable === false) {
    pillLabel = '❌ Backend Offline';
    pillClass = 'bg-red-100 text-red-800';
  } else if (!data) {
    pillLabel = 'checking...';
    pillClass = 'bg-gray-100 text-gray-600';
  } else if (data.status === 'healthy') {
    pillLabel = '✅ Backend';
    pillClass = 'bg-green-100 text-green-800';
  } else {
    pillLabel = '⚠️ Degraded';
    pillClass = 'bg-yellow-100 text-yellow-800';
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={cn('flex items-center gap-1 text-sm px-3 py-1 rounded-full transition-colors', pillClass)}
        aria-label="Backend service status"
        aria-expanded={isOpen}
      >
        {pillLabel}
        <ChevronDown className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-2">
          {data ? (
            (Object.keys(SERVICE_META) as Array<keyof ServicesHealthResponse['services']>).map((key) => {
              const meta = SERVICE_META[key];
              const service = data.services[key];
              const statusMeta = STATUS_META[service.status];
              const Icon = meta.icon;
              return (
                <div key={key} className="flex items-center gap-3 px-4 py-2">
                  <Icon className="h-4 w-4 text-gray-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-medium text-gray-900 truncate"
                      title={SERVICE_TOOLTIP[key]}
                    >
                      {meta.label}
                    </p>
                    {service.detail && (
                      <p className="text-[11px] text-gray-400 truncate" title={service.detail}>{service.detail}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={cn('h-2 w-2 rounded-full', statusMeta.dot)} />
                    <span className={cn('text-xs font-medium', statusMeta.text)}>{statusMeta.label}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-3 text-sm text-gray-500">Unable to reach the backend.</div>
          )}
          {data?.serverTime && (
            <div className="mt-1 pt-2 px-4 border-t border-gray-100 text-[11px] text-gray-500 flex items-center justify-between">
              <span>Server time</span>
              <span>{data.serverTime.local} ({data.serverTime.timezone})</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BackendStatusIndicator;
