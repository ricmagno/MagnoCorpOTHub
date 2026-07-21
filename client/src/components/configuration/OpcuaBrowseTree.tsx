import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, Folder, Activity, ChevronRight, Home, ArrowLeft, Plus, Search } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { cn } from '../../utils/cn';
import { apiService } from '../../services/api';
import { OpcuaTagInfo } from '../../types/opcuaConfig';

interface BreadcrumbEntry {
  nodeId: string;
  displayName: string;
}

interface OpcuaBrowseTreeProps {
  onSelect: (nodeId: string, displayName: string) => void;
  onClose: () => void;
  /**
   * Optional fast-path: renders an inline "Add" button on each variable row that adds
   * the tag directly without closing the browser, so an admin can add several tags in
   * one pass. The row itself still calls onSelect (populate-and-close) for the case
   * where they want to review/edit before adding — this is purely additive convenience.
   */
  onAdd?: (nodeId: string, displayName: string) => void;
  /**
   * OPC UA connection (id or alias) to browse. Omitting it browses the
   * legacy-default connection, which only exists if an admin designated one.
   */
  connectionId?: string;
}

const ROOT: BreadcrumbEntry = { nodeId: 'RootFolder', displayName: 'Root' };

// node-opcua's QualifiedName.toString() returns "namespaceIndex:name" whenever the
// namespace isn't the default (0) — true for most vendor/system folders (e.g.
// "1:_AdvancedTags") — so a raw browseName.startsWith('_') never matched. displayName
// carries no such prefix; fall back to a defensively-stripped browseName if it's empty.
const nodeLabel = (node: OpcuaTagInfo): string => {
  if (node.displayName) return node.displayName;
  const colonIndex = node.browseName.indexOf(':');
  if (colonIndex > 0 && /^\d+$/.test(node.browseName.slice(0, colonIndex))) {
    return node.browseName.slice(colonIndex + 1);
  }
  return node.browseName;
};

const isSystemNode = (node: OpcuaTagInfo): boolean => nodeLabel(node).startsWith('_');

/**
 * Modal OPC UA address-space browser, mirroring DirectoryBrowser.tsx's navigate-in/
 * breadcrumb-out UX. Lets an admin drill into Object nodes and pick a Variable node
 * (a tag) instead of hand-typing node IDs — backed by the existing GET /api/opcua/browse
 * (paginated per-level, since OPC UA address spaces can be arbitrarily deep/wide).
 */
export const OpcuaBrowseTree: React.FC<OpcuaBrowseTreeProps> = ({ onSelect, onClose, onAdd, connectionId }) => {
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbEntry[]>([ROOT]);
  const [nodes, setNodes] = useState<OpcuaTagInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSystemNodes, setShowSystemNodes] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const currentNodeId = breadcrumb[breadcrumb.length - 1]!.nodeId;

  // Drives the scroll-shadow overlays below via real scroll position rather than a
  // CSS background-attachment trick — Safari has long had inconsistent support for
  // `background-attachment: local` on scrollable elements, which silently no-ops the
  // shadow there even though it works in Chrome/Firefox. Measuring scrollTop/
  // scrollHeight directly works identically in every browser.
  const updateScrollShadows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 1);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  const fetchChildren = useCallback(async (nodeId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiService.browseOpcuaTags(nodeId, connectionId);
      if (response.success && response.data) {
        setNodes(response.data);
      } else {
        throw new Error(response.message || 'Failed to browse OPC UA server');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse OPC UA server');
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchChildren(currentNodeId);
  }, [currentNodeId, fetchChildren]);

  const visibleNodes = useMemo(() => {
    const base = showSystemNodes ? nodes : nodes.filter((n) => !isSystemNode(n));
    const term = searchTerm.trim().toLowerCase();
    if (!term) return base;
    return base.filter((n) => nodeLabel(n).toLowerCase().includes(term) || n.nodeId.toLowerCase().includes(term));
  }, [nodes, showSystemNodes, searchTerm]);

  // Re-measure whenever the visible list changes size (new nodes loaded, system-node
  // filter toggled) — the content height changes without a scroll event firing.
  useEffect(() => {
    updateScrollShadows();
  }, [visibleNodes, loading, updateScrollShadows]);

  const handleNavigateInto = (node: OpcuaTagInfo) => {
    setBreadcrumb((prev) => [...prev, { nodeId: node.nodeId, displayName: nodeLabel(node) }]);
    setSearchTerm('');
  };

  const handleBreadcrumbClick = (index: number) => {
    setBreadcrumb((prev) => prev.slice(0, index + 1));
    setSearchTerm('');
  };

  const handleGoUp = () => {
    if (breadcrumb.length > 1) setBreadcrumb((prev) => prev.slice(0, -1));
    setSearchTerm('');
  };

  const handleSelectVariable = (node: OpcuaTagInfo) => {
    onSelect(node.nodeId, nodeLabel(node));
    onClose();
  };

  const handleAddVariable = (e: React.MouseEvent, node: OpcuaTagInfo) => {
    e.stopPropagation();
    onAdd?.(node.nodeId, nodeLabel(node));
  };

  const objects = visibleNodes.filter((n) => n.nodeClass === 'Object');
  const variables = visibleNodes.filter((n) => n.nodeClass === 'Variable');

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full flex flex-col"
        style={{ maxHeight: '80vh' }}
      >
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Browse OPC UA Tags</h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Close tag browser"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>

        <div className="px-6 py-3 border-b border-gray-200 space-y-3">
          <div className="relative">
            <Input
              type="text"
              placeholder="Filter tags in this folder..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pr-9 h-9 text-sm"
              aria-label="Filter tags in the current folder"
            />
            <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showSystemNodes}
              onChange={(e) => setShowSystemNodes(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            Show system nodes (e.g. starting with _)
          </label>
        </div>

        <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-1 text-sm overflow-x-auto">
          {breadcrumb.map((entry, index) => (
            <React.Fragment key={entry.nodeId}>
              {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />}
              <button
                onClick={() => handleBreadcrumbClick(index)}
                className={cn(
                  'px-1.5 py-0.5 rounded whitespace-nowrap hover:bg-gray-200 transition-colors',
                  index === breadcrumb.length - 1 ? 'font-semibold text-gray-900' : 'text-gray-600'
                )}
              >
                {index === 0 && <Home className="h-3.5 w-3.5 inline mr-1 -mt-0.5" />}
                {entry.displayName}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/*
          Wrapper is `relative` so the two shadow overlays below can sit above the
          scrollable list. Their visibility is driven by real scroll position
          (updateScrollShadows), not a CSS background trick — Safari doesn't reliably
          render `background-attachment: local` on scrollable elements, so that
          approach never became visible there even though scrolling itself worked.
        */}
        <div className="relative flex flex-col flex-1 min-h-0">
          <div
            className={cn(
              'pointer-events-none absolute top-0 left-0 right-0 h-4 z-10 transition-opacity',
              canScrollUp ? 'opacity-100' : 'opacity-0'
            )}
            style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0))' }}
          />
          <div
            className={cn(
              'pointer-events-none absolute bottom-0 left-0 right-0 h-4 z-10 transition-opacity',
              canScrollDown ? 'opacity-100' : 'opacity-0'
            )}
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.15), rgba(0,0,0,0))' }}
          />
          <div
            ref={scrollRef}
            onScroll={updateScrollShadows}
            className="flex-1 min-h-0 overflow-y-auto px-6 py-4"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#9ca3af #f3f4f6' } as React.CSSProperties}
          >
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Spinner size="lg" />
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {!loading && !error && (
            <div className="space-y-1">
              {breadcrumb.length > 1 && (
                <button
                  onClick={handleGoUp}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-gray-100 transition-colors text-left"
                >
                  <ArrowLeft className="h-5 w-5 text-gray-500" />
                  <span className="text-sm font-medium text-gray-700">..</span>
                  <span className="text-xs text-gray-500">(up one level)</span>
                </button>
              )}

              {visibleNodes.length === 0 && (
                <div className="py-8 text-center text-gray-500 text-sm">
                  {searchTerm.trim() ? 'No tags match your filter' : 'No child nodes found'}
                </div>
              )}

              {objects.map((node) => (
                <button
                  key={node.nodeId}
                  onClick={() => handleNavigateInto(node)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-gray-100 transition-colors text-left group"
                >
                  <Folder className="h-5 w-5 text-primary-500 shrink-0" />
                  <span className="text-sm font-medium text-gray-900 group-hover:text-primary-700 truncate">
                    {nodeLabel(node)}
                  </span>
                  <ChevronRight className="h-4 w-4 text-gray-400 ml-auto shrink-0" />
                </button>
              ))}

              {variables.map((node) => (
                <div
                  key={node.nodeId}
                  onClick={() => handleSelectVariable(node)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-gray-100 transition-colors text-left group cursor-pointer"
                >
                  <Activity className="h-5 w-5 text-primary-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 group-hover:text-primary-700 truncate">
                      {nodeLabel(node)}
                    </p>
                    <p className="text-xs font-mono text-gray-500 truncate">{node.nodeId}</p>
                  </div>
                  {onAdd && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(e) => handleAddVariable(e, node)}
                      className="shrink-0"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
};

export default OpcuaBrowseTree;
