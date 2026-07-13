import React, { useState, useEffect, useCallback } from 'react';
import { Save, CheckCircle2, XCircle, PlugZap, Boxes } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { TeveHistorizeTags } from './TeveHistorizeTags';

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem('authToken') || ''}`
});

interface TeveForm {
  enabled: boolean;
  baseUrl: string;
}

const DEFAULTS: TeveForm = { enabled: false, baseUrl: '' };

/**
 * Admin settings for the TEVE (Tensor Embedding Vector Engine) integration — a
 * separate, optional time-series/vector-search service deployed in its own
 * container(s) alongside the AVEVA Historian, not a replacement for it. Most
 * deployments won't have this service; it stays disabled until an admin points it
 * at a real instance.
 */
export const TeveConfiguration: React.FC = () => {
  const [form, setForm] = useState<TeveForm>(DEFAULTS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; responseTime?: number } | null>(null);
  const { success, error: toastError } = useToast();

  useEffect(() => {
    fetch('/api/teve-config', { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : DEFAULTS))
      .then((data) => setForm({ ...DEFAULTS, ...data }))
      .finally(() => setIsLoading(false));
  }, []);

  const set = <K extends keyof TeveForm>(key: K, value: TeveForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setTestResult(null);
  };

  const handleSave = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.enabled && !form.baseUrl.trim()) {
      toastError('Base URL required', 'Enter TEVE’s URL before enabling it.');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch('/api/teve-config', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = await res.json();
      setForm({ ...DEFAULTS, ...updated });
      success('TEVE settings saved', 'Your changes are now live.');
    } catch {
      toastError('Save failed', 'Could not update TEVE settings.');
    } finally {
      setIsSaving(false);
    }
  }, [form, success, toastError]);

  const handleTest = useCallback(async () => {
    if (!form.baseUrl.trim()) {
      toastError('Base URL required', 'Enter a URL to test.');
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/teve-config/test', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.baseUrl })
      });
      const data = await res.json();
      setTestResult({ success: !!data.success, message: data.message, responseTime: data.responseTime });
    } catch {
      setTestResult({ success: false, message: 'Request failed' });
    } finally {
      setIsTesting(false);
    }
  }, [form.baseUrl, toastError]);

  if (isLoading) {
    return <div className="text-sm text-gray-500 p-6">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
        <div className="flex items-start gap-3">
          <Boxes className="h-5 w-5 text-gray-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">TEVE</h3>
            <p className="text-xs text-gray-500 mt-1">
              <strong className="font-medium text-gray-600">TEVE</strong> — Tensor Embedding Vector Engine — is
              a modern time-series &amp; vector-search historian, deployed in its own container(s) — usable
              alongside the AVEVA Historian for added capability (screenshot search, similar trends, similar
              anomalies in the Insights tab), or as a standalone alternative historian in its own right. Most
              deployments won't have this running yet; leave disabled if you don't.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => set('enabled', !form.enabled)}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 shrink-0 ml-4',
            form.enabled ? 'bg-primary-600' : 'bg-gray-300'
          )}
          aria-label="Toggle TEVE integration"
        >
          <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', form.enabled ? 'translate-x-6' : 'translate-x-1')} />
        </button>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Service URL</label>
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder="http://historian-api.magnocorp-othub.svc.cluster.local:3100"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Base URL of the historian-api service (see Kubernetes/historian-api-deployment.yaml). Reached
          server-to-server from this app's backend, not from the browser.
        </p>
      </div>

      {testResult && (
        <div className={cn(
          'flex items-center gap-2 text-sm px-3 py-2 rounded-md',
          testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        )}>
          {testResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          <span>
            {testResult.success ? 'Connection successful' : testResult.message || 'Connection failed'}
            {typeof testResult.responseTime === 'number' && ` (${testResult.responseTime}ms)`}
          </span>
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" loading={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Saving…' : 'Save Settings'}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} loading={isTesting}>
          <PlugZap className="h-4 w-4 mr-2" />
          Test Connection
        </Button>
      </div>
      </form>

      <TeveHistorizeTags />
    </div>
  );
};

export default TeveConfiguration;
