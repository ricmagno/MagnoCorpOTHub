import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, ListTree, Search, Server, Download, Upload } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import { Button } from '../ui/Button';
import { OpcuaBrowseTree } from './OpcuaBrowseTree';
import { apiService } from '../../services/api';
import { cn } from '../../utils/cn';

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem('authToken') || ''}`
});

interface HistorizeTag {
  nodeId: string;
  connectionId: string | null;
  tagName: string;
  unit: string | null;
  createdAt: string;
  enabled: boolean;
}

interface ConnectionOption {
  id: string;
  alias: string;
  name: string;
}

/**
 * Which OPC UA tags tensorHistorianIngestService.ts continuously writes into Tensor
 * Historian. Independent of alert-monitored tags (AlertDeliveryConfiguration handles
 * those) — a tag can be historized, alerted on, both, or neither.
 *
 * Multi-connection aware: each tag is bound to an OPC UA connection. Tags with no
 * connection (legacy rows) are only ingested when an admin has designated a
 * legacy-default connection.
 */
export const TeveHistorizeTags: React.FC = () => {
  const [tags, setTags] = useState<HistorizeTag[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [nodeId, setNodeId] = useState('');
  const [tagName, setTagName] = useState('');
  const [unit, setUnit] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { success, error: toastError, warning } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/teve-tag-config', { headers: authHeaders() });
      if (res.ok) setTags(await res.json());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const loadConnections = async () => {
      try {
        const response = await apiService.getOpcuaConfigs();
        if (response.success && response.data) {
          const enabled = response.data
            .filter((c) => c.enabled)
            .map((c) => ({ id: c.id, alias: c.alias, name: c.name }));
          setConnections(enabled);
          if (enabled.length > 0) setConnectionId((prev) => prev || enabled[0].id);
        }
      } catch (err) {
        console.error('Failed to load OPC UA connections:', err);
      }
    };
    loadConnections();
  }, []);

  const connectionLabel = useCallback((id: string | null): string => {
    if (!id) return 'legacy (no connection)';
    const match = connections.find((c) => c.id === id);
    return match ? match.alias : id;
  }, [connections]);

  const persistTag = useCallback(async (tagNodeId: string, tagTagName: string, tagUnit?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/teve-tag-config', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: tagNodeId.trim(),
          tagName: tagTagName.trim(),
          unit: tagUnit?.trim() || undefined,
          connectionId: connectionId || undefined
        })
      });
      if (!res.ok) throw new Error(await res.text());
      setTags(await res.json());
      success('Tag added', `${tagTagName} will be historized from the next OPC UA reconnect/refresh.`);
      return true;
    } catch {
      toastError('Add failed', 'Could not add tag.');
      return false;
    }
  }, [success, toastError, connectionId]);

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nodeId.trim() || !tagName.trim()) {
      toastError('Missing fields', 'Node ID and tag name are both required.');
      return;
    }
    setIsAdding(true);
    const added = await persistTag(nodeId, tagName, unit);
    if (added) {
      setNodeId('');
      setTagName('');
      setUnit('');
    }
    setIsAdding(false);
  }, [nodeId, tagName, unit, persistTag, toastError]);

  const handleBrowseSelect = useCallback((selectedNodeId: string, displayName: string) => {
    setNodeId(selectedNodeId);
    setTagName(displayName);
  }, []);

  // Fast-path from the browse tree's inline Add button: persists immediately and
  // keeps the browser open so an admin can add several tags in one pass, instead of
  // select-review-close-repeat.
  const handleBrowseAdd = useCallback((selectedNodeId: string, displayName: string) => {
    persistTag(selectedNodeId, displayName);
  }, [persistTag]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const res = await fetch('/api/teve-tag-config/export', { headers: authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      const match = disposition ? /filename="(.+)"/.exec(disposition) : null;
      const filename = match?.[1] || 'teve-tags.json';
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      success('Export ready', `Downloaded ${filename}.`);
    } catch {
      toastError('Export failed', 'Could not export tags.');
    } finally {
      setIsExporting(false);
    }
  }, [success, toastError]);

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      toastError('Invalid file', 'Please select a .json file exported from this page.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toastError('File too large', 'Import files must be 10MB or smaller.');
      return;
    }
    setIsImporting(true);
    try {
      const fileContent = await file.text();
      const res = await fetch('/api/teve-tag-config/import', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileContent })
      });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setTags(result.tags ?? []);
      if (result.imported > 0) {
        success('Tags imported', `${result.imported} tag${result.imported === 1 ? '' : 's'} imported.`);
      }
      if (result.warnings?.length) {
        warning('Some tags skipped', result.warnings.slice(0, 3).join(' '));
      }
      if (result.errors?.length) {
        toastError('Some rows had errors', result.errors.slice(0, 3).join(' '));
      }
      if (!result.imported && !result.warnings?.length && !result.errors?.length) {
        toastError('Nothing imported', 'The file contained no tags.');
      }
    } catch {
      toastError('Import failed', 'Could not import tags — check the file is a valid TEVE tag export.');
    } finally {
      setIsImporting(false);
    }
  }, [success, warning, toastError]);

  const handleRemove = useCallback(async (tag: HistorizeTag) => {
    try {
      const query = tag.connectionId ? `?connectionId=${encodeURIComponent(tag.connectionId)}` : '';
      const res = await fetch(`/api/teve-tag-config/${encodeURIComponent(tag.nodeId)}${query}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (!res.ok) throw new Error(await res.text());
      setTags(await res.json());
    } catch {
      toastError('Remove failed', 'Could not remove tag.');
    }
  }, [toastError]);

  const handleToggleEnabled = useCallback(async (tag: HistorizeTag) => {
    const nextEnabled = !tag.enabled;
    setTags((prev) => prev.map((t) => (t === tag ? { ...t, enabled: nextEnabled } : t)));
    try {
      const query = tag.connectionId ? `?connectionId=${encodeURIComponent(tag.connectionId)}` : '';
      const res = await fetch(`/api/teve-tag-config/${encodeURIComponent(tag.nodeId)}${query}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled })
      });
      if (!res.ok) throw new Error(await res.text());
      setTags(await res.json());
    } catch {
      setTags((prev) => prev.map((t) => (t === tag ? { ...t, enabled: tag.enabled } : t)));
      toastError('Update failed', `Could not ${nextEnabled ? 'enable' : 'disable'} ${tag.tagName}.`);
    }
  }, [toastError]);

  const selectedConnection = connections.find((c) => c.id === connectionId);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <ListTree className="h-5 w-5 text-gray-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Tags to Historize</h3>
            <p className="text-xs text-gray-500 mt-1">
              OPC UA tags continuously written into TEVE. Changes take effect on the next OPC UA
              reconnect (or you can trigger a refresh from the OPC UA connection settings).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="outline" size="sm" onClick={handleExport} loading={isExporting}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} loading={isImporting}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Import
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
        </div>
      </div>

      <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr_1fr_auto] gap-3 items-end">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Connection</label>
          <div className="flex items-center gap-1.5">
            <Server className="h-4 w-4 text-gray-400 shrink-0" />
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              className="w-full px-2 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {connections.length === 0 && <option value="">No enabled connections</option>}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.alias})</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Node ID</label>
          <div className="flex gap-1.5">
            <input
              type="text" value={nodeId} onChange={(e) => setNodeId(e.target.value)}
              placeholder="ns=2;s=Reactor1.Temperature"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowBrowser(true)}
              title="Browse the OPC UA server's tag tree instead of typing a node ID"
              className="shrink-0 px-2.5"
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tag name</label>
          <input
            type="text" value={tagName} onChange={(e) => setTagName(e.target.value)}
            placeholder="Reactor1.Temperature"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Unit (optional)</label>
          <input
            type="text" value={unit} onChange={(e) => setUnit(e.target.value)}
            placeholder="degC"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <Button type="submit" loading={isAdding}>
          <Plus className="h-4 w-4 mr-2" />
          Add
        </Button>
      </form>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : tags.length === 0 ? (
        <div className="text-sm text-gray-500 py-6 text-center bg-gray-50 rounded-lg">
          No tags configured — TEVE ingestion is idle until at least one is added.
        </div>
      ) : (
        <div className="space-y-1.5">
          {tags.map((t) => (
            <div key={`${t.connectionId ?? ''}:${t.nodeId}`} className={cn('flex items-center justify-between px-3 py-2 bg-gray-50 rounded-md', !t.enabled && 'opacity-60')}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">{t.tagName}</p>
                <p className="text-xs font-mono text-gray-500 truncate">
                  <span className={t.connectionId ? 'text-primary-600' : 'text-amber-600'} title={t.connectionId ? undefined : 'Legacy row: only ingested when a legacy-default connection is designated'}>
                    [{connectionLabel(t.connectionId)}]
                  </span>{' '}
                  {t.nodeId}{t.unit ? ` · ${t.unit}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <button
                  type="button"
                  onClick={() => handleToggleEnabled(t)}
                  className={cn(
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1',
                    t.enabled ? 'bg-primary-600' : 'bg-gray-300'
                  )}
                  title={t.enabled ? 'Disable data collection for this tag' : 'Enable data collection for this tag'}
                  aria-label={`${t.enabled ? 'Disable' : 'Enable'} ${t.tagName}`}
                >
                  <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', t.enabled ? 'translate-x-4' : 'translate-x-0.5')} />
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(t)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                  aria-label={`Remove ${t.tagName}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showBrowser && (
        <OpcuaBrowseTree
          onSelect={handleBrowseSelect}
          onAdd={handleBrowseAdd}
          onClose={() => setShowBrowser(false)}
          connectionId={selectedConnection?.alias}
        />
      )}
    </div>
  );
};

export default TeveHistorizeTags;
