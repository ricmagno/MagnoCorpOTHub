import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ListTree, Search } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import { Button } from '../ui/Button';
import { OpcuaBrowseTree } from './OpcuaBrowseTree';

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem('authToken') || ''}`
});

interface HistorizeTag {
  nodeId: string;
  tagName: string;
  unit: string | null;
  createdAt: string;
}

/**
 * Which OPC UA tags tensorHistorianIngestService.ts continuously writes into Tensor
 * Historian. Independent of alert-monitored tags (AlertDeliveryConfiguration handles
 * those) — a tag can be historized, alerted on, both, or neither.
 */
export const TeveHistorizeTags: React.FC = () => {
  const [tags, setTags] = useState<HistorizeTag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [nodeId, setNodeId] = useState('');
  const [tagName, setTagName] = useState('');
  const [unit, setUnit] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/teve-tag-config', { headers: authHeaders() });
      if (res.ok) setTags(await res.json());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const persistTag = useCallback(async (tagNodeId: string, tagTagName: string, tagUnit?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/teve-tag-config', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: tagNodeId.trim(), tagName: tagTagName.trim(), unit: tagUnit?.trim() || undefined })
      });
      if (!res.ok) throw new Error(await res.text());
      setTags(await res.json());
      success('Tag added', `${tagTagName} will be historized from the next OPC UA reconnect/refresh.`);
      return true;
    } catch {
      toastError('Add failed', 'Could not add tag.');
      return false;
    }
  }, [success, toastError]);

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

  const handleRemove = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/teve-tag-config/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (!res.ok) throw new Error(await res.text());
      setTags(await res.json());
    } catch {
      toastError('Remove failed', 'Could not remove tag.');
    }
  }, [toastError]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <ListTree className="h-5 w-5 text-gray-400 mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Tags to Historize</h3>
          <p className="text-xs text-gray-500 mt-1">
            OPC UA tags continuously written into Tensor Historian. Changes take effect on the next OPC UA
            reconnect (or you can trigger a refresh from the OPC UA connection settings).
          </p>
        </div>
      </div>

      <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-3 items-end">
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
          No tags configured — Tensor Historian ingestion is idle until at least one is added.
        </div>
      ) : (
        <div className="space-y-1.5">
          {tags.map((t) => (
            <div key={t.nodeId} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-md">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">{t.tagName}</p>
                <p className="text-xs font-mono text-gray-500 truncate">{t.nodeId}{t.unit ? ` · ${t.unit}` : ''}</p>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(t.nodeId)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md shrink-0 ml-3"
                aria-label={`Remove ${t.tagName}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showBrowser && (
        <OpcuaBrowseTree
          onSelect={handleBrowseSelect}
          onAdd={handleBrowseAdd}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
};

export default TeveHistorizeTags;
