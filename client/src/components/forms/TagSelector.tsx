import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { Search, Tag, X, Plus, RefreshCw, Server, Activity } from 'lucide-react';
import { TagInfo } from '../../types/api';
import { OpcuaTagInfo } from '../../types/opcuaConfig';
import { apiService } from '../../services/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Card, CardContent, CardHeader } from '../ui/Card';
import { cn } from '../../utils/cn';

interface TagSelectorProps {
  selectedTags: string[];
  onChange: (tags: string[]) => void;
  className?: string;
  maxTags?: number;
  widgetType?: string;
}

const OPCUA_ROW_HEIGHT = 40;

interface OpcuaNodeRowProps {
  tags: OpcuaTagInfo[];
  selectedTags: string[];
  opcuaConnectionAlias: string;
  onNavigate: (nodeId: string) => void;
  onToggleTag: (node: OpcuaTagInfo, qualifiedTag: string, isSelected: boolean) => void;
}

// Extracted so react-window can render it as a row; the list itself is
// virtualized (see List below), so at most ~15 of these ever mount at once
// regardless of how many nodes (confirmed up to 1800+ on a real PLC) are in
// the current folder — that bound is what actually fixes the freeze.
function OpcuaNodeRow({
  index,
  style,
  tags,
  selectedTags,
  opcuaConnectionAlias,
  onNavigate,
  onToggleTag,
}: RowComponentProps<OpcuaNodeRowProps>) {
  const node = tags[index];
  const isOpcuaTag = node.nodeClass === 'Variable';
  const qualifiedTag = opcuaConnectionAlias
    ? `opcua:${opcuaConnectionAlias}:${node.nodeId}`
    : `opcua:${node.nodeId}`;
  const isSelected = selectedTags.includes(qualifiedTag) || selectedTags.includes(`opcua:${node.nodeId}`);

  return (
    <div style={style} className="flex items-center justify-between group px-0.5 py-[2px]">
      <button
        onClick={() => {
          if (!isOpcuaTag) onNavigate(node.nodeId);
        }}
        disabled={isOpcuaTag}
        className={cn(
          'flex-1 h-full text-left px-3 text-sm rounded-l-md transition-all',
          isOpcuaTag
            ? 'cursor-default bg-white/50 border border-transparent'
            : 'hover:bg-blue-50 text-blue-700 bg-white border border-gray-100 shadow-sm hover:border-blue-200'
        )}
      >
        <div className="flex items-center h-full">
          {isOpcuaTag
            ? <Activity className="h-3.5 w-3.5 mr-2 text-indigo-400 flex-shrink-0" />
            : <Server className="h-3.5 w-3.5 mr-2 text-blue-500 flex-shrink-0" />
          }
          <span className={cn(
            "font-medium truncate max-w-[200px]",
            isOpcuaTag ? "text-gray-700" : "text-blue-700"
          )}>
            {node.displayName}
          </span>
        </div>
      </button>
      {isOpcuaTag && (
        <Button
          size="sm"
          variant={isSelected ? "secondary" : "outline"}
          onClick={() => onToggleTag(node, qualifiedTag, isSelected)}
          className="h-full px-2 rounded-l-none"
        >
          {isSelected ? 'Remove' : 'Add'}
        </Button>
      )}
    </div>
  );
}

export const TagSelector: React.FC<TagSelectorProps> = React.memo(function TagSelector({
  selectedTags,
  onChange,
  className,
  maxTags = 10,
  widgetType,
}) {
  const [availableTags, setAvailableTags] = useState<TagInfo[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  // OPC UA States
  const [opcuaTags, setOpcuaTags] = useState<OpcuaTagInfo[]>([]);
  const [opcuaPath, setOpcuaPath] = useState<string[]>(['ns=0;i=85']); // Root Objects folder
  const [isBrowsingOpcua, setIsBrowsingOpcua] = useState(false);
  const [tagSourceTab, setTagSourceTab] = useState<'historian' | 'opcua'>('historian');
  const [opcuaSearchTerm, setOpcuaSearchTerm] = useState('');
  const [showSystemNodes, setShowSystemNodes] = useState(false);
  // Enabled OPC UA connections; tags are emitted qualified as opcua:<alias>:<nodeId>
  const [opcuaConnections, setOpcuaConnections] = useState<{ id: string; alias: string; name: string }[]>([]);
  const [opcuaConnectionAlias, setOpcuaConnectionAlias] = useState<string>('');

  // OPC UA allowed widget types
  const isLiveWidget = widgetType === 'value-block' || widgetType === 'radial-gauge' || widgetType === 'radar';

  // Switch to historian tab if widgetType changes and opcua is not allowed
  useEffect(() => {
    if (!isLiveWidget && tagSourceTab === 'opcua') {
      setTagSourceTab('historian');
    }
  }, [isLiveWidget, tagSourceTab]);

  // Load available tags (Historian)
  useEffect(() => {
    const loadTags = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.getTags();
        if (response.success) {
          setAvailableTags(response.data);
        } else {
          setError('Failed to load tags');
        }
      } catch (err) {
        console.warn('Failed to load tags from API, using fallback:', err);
        const mockTags: TagInfo[] = [
          { name: 'Temperature_01', description: 'Temperature sensor 1', units: '°C', dataType: 'analog', lastUpdate: new Date() },
          { name: 'Pressure_01', description: 'Pressure sensor 1', units: 'PSI', dataType: 'analog', lastUpdate: new Date() },
        ];
        setAvailableTags(mockTags);
      } finally {
        setLoading(false);
      }
    };

    loadTags();
  }, []);

  // Load enabled OPC UA connections when the opcua tab is first used
  useEffect(() => {
    if (tagSourceTab !== 'opcua' || !isLiveWidget || opcuaConnections.length > 0) return;
    const loadConnections = async () => {
      try {
        const response = await apiService.getOpcuaConfigs();
        if (response.success && response.data) {
          const enabled = response.data
            .filter((c) => c.enabled)
            .map((c) => ({ id: c.id, alias: c.alias, name: c.name }));
          setOpcuaConnections(enabled);
          if (enabled.length > 0 && !opcuaConnectionAlias) {
            setOpcuaConnectionAlias(enabled[0].alias);
          }
        }
      } catch (error) {
        console.error('Failed to load OPC UA connections:', error);
      }
    };
    loadConnections();
  }, [tagSourceTab, isLiveWidget, opcuaConnections.length, opcuaConnectionAlias]);

  // Fetch OPC UA tags when path or connection changes
  useEffect(() => {
    if (tagSourceTab === 'opcua' && isLiveWidget && opcuaConnectionAlias) {
      const fetchOpcua = async () => {
        try {
          setIsBrowsingOpcua(true);
          const response = await apiService.browseOpcuaTags(opcuaPath[opcuaPath.length - 1], opcuaConnectionAlias);
          if (response.success && response.data) {
            setOpcuaTags(response.data);
          }
        } catch (error) {
          console.error('Failed to fetch OPC UA tags:', error);
          setError('Failed to fetch OPC UA nodes');
        } finally {
          setIsBrowsingOpcua(false);
        }
      };
      fetchOpcua();
    }
  }, [opcuaPath, tagSourceTab, widgetType, isLiveWidget, opcuaConnectionAlias]);

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.tag-selector-dropdown')) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter tags based on search term
  const filteredTags = useMemo(() => {
    if (!searchTerm) return availableTags;
    const term = searchTerm.toLowerCase();
    return availableTags.filter(tag =>
      tag.name.toLowerCase().includes(term) ||
      tag.description.toLowerCase().includes(term)
    );
  }, [availableTags, searchTerm]);

  // Filter OPC UA tags based on search term
  const filteredOpcuaTags = useMemo(() => {
    let filtered = opcuaTags;

    // Hide system nodes if toggle is off
    if (!showSystemNodes) {
      filtered = filtered.filter(node => !node.displayName.startsWith('_'));
    }

    if (!opcuaSearchTerm) return filtered;

    const term = opcuaSearchTerm.toLowerCase();
    return filtered.filter(node =>
      node.nodeClass !== 'Variable' || // Always show folders/objects to allow navigation
      node.displayName.toLowerCase().includes(term) ||
      node.nodeId.toLowerCase().includes(term)
    );
  }, [opcuaTags, opcuaSearchTerm, showSystemNodes]);

  // Available tags that aren't already selected
  const unselectedTags = useMemo(() => {
    return filteredTags.filter(tag => !selectedTags.includes(tag.name));
  }, [filteredTags, selectedTags]);

  const handleAddTag = useCallback((tagName: string) => {
    // Check if it's an OPC UA tag
    if (tagName.startsWith('opcua:')) {
      if (!isLiveWidget) {
        setError('OPC UA tags are restricted to live data widgets (Value Block, Radial Gauge, Radar Chart).');
        return;
      }
    }

    if (selectedTags.length >= maxTags) {
      setError(`Maximum ${maxTags} tags allowed`);
      return;
    }

    if (!selectedTags.includes(tagName)) {
      onChange([...selectedTags, tagName]);
      setSearchTerm('');
      setShowDropdown(false);
      setError(null);
    }
  }, [isLiveWidget, selectedTags, maxTags, onChange]);

  const handleNavigateOpcua = useCallback((nodeId: string) => {
    setOpcuaPath(prev => [...prev, nodeId]);
  }, []);

  const handleToggleOpcuaTag = useCallback((node: OpcuaTagInfo, qualifiedTag: string, isSelected: boolean) => {
    if (isSelected) {
      onChange(selectedTags.filter(t => t !== qualifiedTag && t !== `opcua:${node.nodeId}`));
      setError(null);
    } else {
      handleAddTag(qualifiedTag);
    }
  }, [selectedTags, onChange, handleAddTag]);

  const opcuaRowProps = useMemo(() => ({
    tags: filteredOpcuaTags,
    selectedTags,
    opcuaConnectionAlias,
    onNavigate: handleNavigateOpcua,
    onToggleTag: handleToggleOpcuaTag,
  }), [filteredOpcuaTags, selectedTags, opcuaConnectionAlias, handleNavigateOpcua, handleToggleOpcuaTag]);

  const handleManualAdd = () => {
    if (!searchTerm.trim()) return;
    let tagName = searchTerm.trim();
    if (tagName.includes('ns=') && !tagName.startsWith('opcua:')) {
      tagName = `opcua:${tagName}`;
    }
    handleAddTag(tagName);
  };

  const handleRemoveTag = (tagName: string) => {
    onChange(selectedTags.filter(tag => tag !== tagName));
    setError(null);
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Tag className="h-5 w-5 text-gray-500" />
            <h3 className="text-lg font-medium">Tag Selection</h3>
          </div>
          <span className="text-sm text-gray-500">
            {selectedTags.length}/{maxTags} selected
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Source Tabs */}
        {isLiveWidget && (
          <div className="flex space-x-4 border-b border-gray-100 mb-2">
            <button
              onClick={() => setTagSourceTab('historian')}
              className={cn(
                "pb-2 px-1 text-sm font-medium transition-colors border-b-2",
                tagSourceTab === 'historian'
                  ? "border-primary-600 text-primary-600"
                  : "border-transparent text-gray-400 hover:text-gray-600"
              )}
            >
              Historian
            </button>
            <button
              onClick={() => setTagSourceTab('opcua')}
              className={cn(
                "pb-2 px-1 text-sm font-medium transition-colors border-b-2",
                tagSourceTab === 'opcua'
                  ? "border-primary-600 text-primary-600"
                  : "border-transparent text-gray-400 hover:text-gray-600"
              )}
            >
              OPC UA Discovery
            </button>
          </div>
        )}

        {tagSourceTab === 'historian' ? (
          <>
            {/* Search input */}
            <div className="relative tag-selector-dropdown">
              <Input
                type="text"
                placeholder="Search tags..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setShowDropdown(true);
                }}
                onFocus={() => setShowDropdown(true)}
                className="pr-10"
              />
              <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />

              {/* Dropdown */}
              {showDropdown && (unselectedTags.length > 0 || searchTerm) && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto">
                  {loading ? (
                    <div className="p-3 text-center text-gray-500">Loading tags...</div>
                  ) : (
                    <>
                      {unselectedTags.slice(0, 20).map((tag) => (
                        <button
                          key={tag.name}
                          className="w-full px-3 py-2 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none border-b border-gray-100 last:border-0"
                          onClick={() => handleAddTag(tag.name)}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-gray-900">{tag.name}</div>
                              <div className="text-sm text-gray-500 truncate">
                                {tag.description}
                              </div>
                            </div>
                            <div className="text-xs text-gray-400 ml-2">
                              {tag.units}
                            </div>
                          </div>
                        </button>
                      ))}

                      {searchTerm && !unselectedTags.some(t => t.name.toLowerCase() === searchTerm.toLowerCase()) && (
                        <button
                          className="w-full px-3 py-3 text-left hover:bg-primary-50 focus:bg-primary-50 focus:outline-none bg-primary-50/30 text-primary-700"
                          onClick={handleManualAdd}
                        >
                          <div className="flex items-center">
                            <Plus className="h-4 w-4 mr-2" />
                            <div className="font-medium">Add "{searchTerm}"</div>
                            <span className="ml-auto text-[10px] uppercase font-bold text-primary-400 tracking-wider">Manual Entry</span>
                          </div>
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          /* OPC UA Discovery UI */
          <div className="space-y-4 border rounded-md p-3 bg-gray-50/30 shadow-sm transition-all">
            {/* OPC UA Search & Filter */}
            <div className="flex flex-col space-y-2">
              <div className="relative">
                <Input
                  type="text"
                  placeholder="Search OPC UA nodes..."
                  value={opcuaSearchTerm}
                  onChange={(e) => setOpcuaSearchTerm(e.target.value)}
                  className="pr-10 h-9 text-sm"
                />
                <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              </div>

              <div className="flex items-center space-x-2 px-1">
                <input
                  type="checkbox"
                  id="show-system-nodes"
                  checked={showSystemNodes}
                  onChange={(e) => setShowSystemNodes(e.target.checked)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 h-3.5 w-3.5"
                />
                <label htmlFor="show-system-nodes" className="text-xs text-gray-500 cursor-pointer select-none">
                  Show system nodes (e.g. starting with _)
                </label>
              </div>
            </div>

            {/* Connection selector — tags are added as opcua:<alias>:<nodeId> */}
            {opcuaConnections.length > 0 && (
              <div className="flex items-center space-x-2 px-1">
                <Server className="h-3.5 w-3.5 text-gray-400" />
                <select
                  className="text-xs rounded-md border border-gray-300 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={opcuaConnectionAlias}
                  onChange={(e) => {
                    setOpcuaConnectionAlias(e.target.value);
                    setOpcuaPath(['ns=0;i=85']);
                  }}
                >
                  {opcuaConnections.map((c) => (
                    <option key={c.id} value={c.alias}>{c.name} ({c.alias})</option>
                  ))}
                </select>
              </div>
            )}

            {/* Navigation breadcrumbs */}
            <div className="flex items-center text-xs text-primary-600 overflow-x-auto whitespace-nowrap pb-1 border-b border-gray-100">
              <button
                onClick={() => {
                  setOpcuaPath(['ns=0;i=85']);
                }}
                className="hover:underline flex-shrink-0 font-semibold"
              > Root </button>
              {opcuaPath.length > 1 && opcuaPath.slice(1).map((nodeId, idx) => (
                <React.Fragment key={nodeId}>
                  <span className="mx-1 text-gray-400">/</span>
                  <button
                    onClick={() => {
                      setOpcuaPath(opcuaPath.slice(0, idx + 2));
                    }}
                    className="hover:underline truncate max-w-[100px] font-medium"
                    title={nodeId}
                  > {nodeId.split(';')[1] || nodeId} </button>
                </React.Fragment>
              ))}
            </div>

            <div className="border border-gray-100 rounded-md bg-white overflow-hidden">
              {isBrowsingOpcua ? (
                <div className="flex flex-col items-center justify-center py-8 text-gray-400">
                  <RefreshCw className="h-6 w-6 animate-spin text-primary-500 mb-2" />
                  <span className="text-xs">Browsing OPC UA...</span>
                </div>
              ) : filteredOpcuaTags.length === 0 ? (
                <div className="px-3 py-6 text-sm text-gray-400 italic text-center border border-dashed border-gray-200">
                  {opcuaSearchTerm ? 'No nodes match your search' : 'No nodes found in this folder'}
                </div>
              ) : (
                // Virtualized: a folder can have 1000+ flat children on real PLCs (confirmed
                // against a live B&R device) — rendering all of them as real DOM nodes on every
                // selection is what caused whole-app freezes. Only ~7 rows (280/40) are ever
                // actually mounted at once, regardless of filteredOpcuaTags.length.
                <List
                  rowComponent={OpcuaNodeRow}
                  rowCount={filteredOpcuaTags.length}
                  rowHeight={OPCUA_ROW_HEIGHT}
                  rowProps={opcuaRowProps}
                  style={{ height: 280 }}
                  className="custom-scrollbar"
                />
              )}
            </div>
          </div>
        )}

        {/* Selected tags */}
        {selectedTags.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700">Selected Tags:</h4>
            <div className="flex flex-wrap gap-2">
              {selectedTags.map((tagName) => {
                const isOpcua = tagName.startsWith('opcua:');
                return (
                  <div
                    key={tagName}
                    className={cn(
                      'inline-flex items-center px-3 py-1 rounded-full text-sm border',
                      isOpcua
                        ? 'bg-blue-100 text-blue-800 border-blue-200'
                        : 'bg-primary-100 text-primary-800 border-primary-200'
                    )}
                  >
                    <span className="mr-2">{isOpcua ? tagName.replace('opcua:', 'OPC: ') : tagName}</span>
                    <button
                      onClick={() => handleRemoveTag(tagName)}
                      className="ml-1 hover:text-gray-900 focus:outline-none"
                      aria-label={`Remove ${tagName}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="text-sm text-error bg-red-50 p-3 rounded-md">
            {error}
          </div>
        )}

        {/* Empty state */}
        {selectedTags.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <Tag className="h-12 w-12 mx-auto mb-4 text-gray-300" />
            <p>No tags selected</p>
            <p className="text-sm">Search and select tags to include</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
});