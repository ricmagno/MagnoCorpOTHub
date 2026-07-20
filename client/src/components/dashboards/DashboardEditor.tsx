import React, { useState, useEffect } from 'react';
import {
    Plus,
    Trash2,
    Save,
    ArrowLeft,
    Settings,
    Layout,
    BarChart,
    Type,
    Move,
    CheckCircle2,
    XCircle
} from 'lucide-react';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    type DragEndEvent
} from '@dnd-kit/core';
import {
    SortableContext,
    verticalListSortingStrategy,
    useSortable,
    arrayMove,
    sortableKeyboardCoordinates
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent, CardHeader } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { TagSelector } from '../forms/TagSelector';
import { DashboardConfig, WidgetConfig, WidgetType } from '../../types/dashboard';
import { apiService } from '../../services/api';
import { useToast } from '../../hooks/useToast';
const generateId = () => Math.random().toString(36).substring(2, 11);

// Widget types forced to a 1/4-width block (w:1, h:1) rather than the normal
// half/full-width chart sizing. Shared constant so every place that needs to know
// "is this a small widget" (layout sanitization, add/type-switch enforcement, the
// Width dropdown's option set) stays in sync — a type only needs to be added here once.
const SMALL_WIDGET_TYPES: WidgetType[] = ['value-block', 'radial-gauge', 'normal-distribution'];
const isSmallWidgetType = (type: WidgetType): boolean => SMALL_WIDGET_TYPES.includes(type);

interface DashboardEditorProps {
    dashboardId?: string | null;
    onSave: () => void;
    onCancel: () => void;
}

export const DashboardEditor: React.FC<DashboardEditorProps> = ({
    dashboardId,
    onSave,
    onCancel
}) => {
    const [config, setConfig] = useState<DashboardConfig>({
        name: '',
        description: '',
        widgets: [],
        timeRange: {
            relativeRange: 'last1h'
        },
        refreshRate: 30
    });

    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const { success, error } = useToast();

    useEffect(() => {
        if (dashboardId) {
            const fetchDashboard = async () => {
                try {
                    setLoading(true);
                    const response = await apiService.loadDashboard(dashboardId);
                    if (response.success) {
                        const loadedConfig = response.data.config;
                        // Sanitize layout for legacy data
                        if (loadedConfig.widgets) {
                            loadedConfig.widgets = loadedConfig.widgets.map((w: WidgetConfig) => {
                                const isSmall = isSmallWidgetType(w.type);
                                if (isSmall && w.layout.w !== 1) {
                                    return { ...w, layout: { ...w.layout, w: 1, h: 1 } };
                                }
                                if (!isSmall && w.layout.w === 1) {
                                    return { ...w, layout: { ...w.layout, w: 2, h: 1 } };
                                }
                                return w;
                            });
                        }
                        setConfig(loadedConfig);
                    } else {
                        error('Failed to load dashboard');
                    }
                } catch (err) {
                    console.error(err);
                    error('Error loading dashboard');
                } finally {
                    setLoading(false);
                }
            };
            fetchDashboard();
        }
    }, [dashboardId]);

    const handleAddWidget = () => {
        const newWidget: WidgetConfig = {
            id: generateId(),
            type: 'line',
            title: `New Widget ${config.widgets.length + 1}`,
            tags: [],
            layout: { x: 0, y: 0, w: 2, h: 1 } // Chart default width is 2
        };
        setConfig(prev => ({
            ...prev,
            widgets: [...prev.widgets, newWidget]
        }));
    };

    const handleUpdateWidget = (id: string, updates: Partial<WidgetConfig>) => {
        setConfig(prev => ({
            ...prev,
            widgets: prev.widgets.map(w => {
                if (w.id !== id) return w;

                const updated = { ...w, ...updates };

                // Enforce width rules when type changes
                if (updates.type) {
                    const isSmallWidget = isSmallWidgetType(updates.type);
                    const wasSmallWidget = isSmallWidgetType(w.type);

                    if (isSmallWidget) {
                        updated.layout = { ...updated.layout, w: 1, h: 1 };
                    } else if (wasSmallWidget) {
                        // Switching from a small widget to a chart
                        updated.layout = { ...updated.layout, w: 2, h: 1 };
                    }
                }

                return updated;
            })
        }));
    };

    const handleRemoveWidget = (id: string) => {
        setConfig(prev => ({
            ...prev,
            widgets: prev.widgets.filter(w => w.id !== id)
        }));
    };

    // DashboardView.tsx renders widgets in plain array order via a flow-based CSS
    // grid (no absolute x/y positioning) — so reordering config.widgets is exactly
    // what changes the rendered order. A small pointer-move threshold before a drag
    // "activates" so a plain click on the card (e.g. focusing an input) never gets
    // mistaken for a drag start.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        setConfig(prev => {
            const oldIndex = prev.widgets.findIndex(w => w.id === active.id);
            const newIndex = prev.widgets.findIndex(w => w.id === over.id);
            if (oldIndex === -1 || newIndex === -1) return prev;
            return { ...prev, widgets: arrayMove(prev.widgets, oldIndex, newIndex) };
        });
    };

    const handleSave = async () => {
        if (!config.name) {
            error('Dashboard name is required');
            return;
        }

        try {
            setSaving(true);
            const payload = {
                name: config.name,
                description: config.description,
                config: config
            };

            const response = await apiService.saveDashboard(payload);
            if (response.success) {
                success(`Dashboard "${config.name}" saved successfully`);
                onSave();
            } else {
                error(response.message || 'Failed to save dashboard');
            }
        } catch (err) {
            console.error(err);
            error('Error saving dashboard');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-20">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                        <ArrowLeft className="h-5 w-5 text-gray-600" />
                    </button>
                    <h2 className="text-2xl font-bold text-gray-900">
                        {dashboardId ? 'Edit Dashboard' : 'Create New Dashboard'}
                    </h2>
                </div>
                <div className="flex items-center gap-3">
                    <Button variant="outline" onClick={onCancel}>Cancel</Button>
                    <Button onClick={handleSave} loading={saving}>
                        <Save className="h-4 w-4 mr-2" />
                        Save Dashboard
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-1 space-y-6">
                    <Card>
                        <CardHeader className="flex flex-row items-center gap-2">
                            <Settings className="h-4 w-4 text-primary-600" />
                            <h3 className="font-semibold text-gray-900">General Settings</h3>
                        </CardHeader>
                        <CardContent className="space-y-4 pt-4">
                            <Input
                                label="Dashboard Name"
                                placeholder="e.g. Production Overview"
                                value={config.name}
                                onChange={e => setConfig({ ...config, name: e.target.value })}
                                required
                            />
                            <div className="space-y-1">
                                <label className="block text-sm font-medium text-gray-700">Description</label>
                                <textarea
                                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
                                    rows={3}
                                    value={config.description}
                                    onChange={e => setConfig({ ...config, description: e.target.value })}
                                    placeholder="Optional description of this dashboard..."
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <Input
                                    label="Refresh Rate (s)"
                                    type="number"
                                    min={5}
                                    value={config.refreshRate}
                                    onChange={e => setConfig({ ...config, refreshRate: parseInt(e.target.value) || 30 })}
                                />
                                <div className="space-y-1">
                                    <label className="block text-sm font-medium text-gray-700">Time Range</label>
                                    <select
                                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
                                        value={config.timeRange.relativeRange}
                                        onChange={e => setConfig({
                                            ...config,
                                            timeRange: { ...config.timeRange, relativeRange: e.target.value as any }
                                        })}
                                    >
                                        <option value="last1h">Last 1 Hour</option>
                                        <option value="last6h">Last 6 Hours</option>
                                        <option value="last12h">Last 12 Hours</option>
                                        <option value="last24h">Last 24 Hours</option>
                                        <option value="last7d">Last 7 Days</option>
                                    </select>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Button variant="outline" className="w-full border-dashed border-2 py-8 h-auto" onClick={handleAddWidget}>
                        <Plus className="h-6 w-6 mr-2" />
                        Add New Widget
                    </Button>
                </div>

                <div className="lg:col-span-2 space-y-6">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                            <Layout className="h-4 w-4 text-primary-600" />
                            Widgets Configuration
                        </h3>
                        <span className="text-xs text-gray-500">{config.widgets.length} Widgets</span>
                    </div>

                    <div className="space-y-4">
                        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                            <SortableContext
                                items={config.widgets.map(w => w.id)}
                                strategy={verticalListSortingStrategy}
                            >
                                {config.widgets.map((widget, index) => (
                                    <SortableWidgetCard
                                        key={widget.id}
                                        widget={widget}
                                        index={index}
                                        onUpdate={handleUpdateWidget}
                                        onRemove={handleRemoveWidget}
                                    />
                                ))}
                            </SortableContext>
                        </DndContext>

                        {config.widgets.length === 0 && (
                            <div className="bg-gray-50 border-2 border-dashed border-gray-200 rounded-lg p-12 text-center text-gray-400">
                                <p>No widgets added to this dashboard yet.</p>
                                <button
                                    onClick={handleAddWidget}
                                    className="mt-2 text-primary-600 font-medium hover:underline flex items-center justify-center mx-auto"
                                >
                                    <Plus className="h-4 w-4 mr-1" /> Add your first widget
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

interface SortableWidgetCardProps {
    widget: WidgetConfig;
    index: number;
    onUpdate: (id: string, updates: Partial<WidgetConfig>) => void;
    onRemove: (id: string) => void;
}

// Drag-and-drop is confined to the dedicated handle (the Move icon button) rather
// than the whole card — the card is full of inputs/selects/the tag picker, and
// attaching drag listeners to the entire card would fight with clicking into them.
const SortableWidgetCard: React.FC<SortableWidgetCardProps> = ({ widget, index, onUpdate, onRemove }) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: widget.id });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : undefined
    };

    return (
        <Card ref={setNodeRef} style={style} className="border-l-4 border-l-primary-500">
            <CardHeader className="py-3 px-4 flex flex-row items-center justify-between bg-gray-50/50">
                <div className="flex items-center gap-2">
                    <button
                        {...attributes}
                        {...listeners}
                        className="p-1 text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
                        title="Drag to reorder"
                        aria-label={`Reorder ${widget.title || 'widget'}`}
                    >
                        <Move className="h-4 w-4" />
                    </button>
                    <span className="bg-primary-600 text-white w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold">
                        {index + 1}
                    </span>
                    <h4 className="font-medium text-gray-900 truncate max-w-[200px]">
                        {widget.title || 'Untitled Widget'}
                    </h4>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onRemove(widget.id)}
                        className="p-1 hover:bg-red-50 text-gray-400 hover:text-red-500 rounded transition-colors"
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </div>
            </CardHeader>
            <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-4">
                    <Input
                        label="Widget Title"
                        value={widget.title}
                        onChange={e => onUpdate(widget.id, { title: e.target.value })}
                    />
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="block text-sm font-medium text-gray-700">Type</label>
                            <select
                                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
                                value={widget.type}
                                onChange={e => onUpdate(widget.id, { type: e.target.value as any })}
                            >
                                <option value="line">Line Chart</option>
                                <option value="bar">Bar Chart</option>
                                <option value="trend">Trend Line</option>
                                <option value="area">Area Chart</option>
                                <option value="radial-gauge">Radial Gauge %</option>
                                <option value="value-block">Value Block</option>
                                <option value="radar">Radar Chart</option>
                                <option value="normal-distribution">Standard Normal Distribution</option>
                            </select>
                        </div>
                        <div className="space-y-1">
                            <label className="block text-sm font-medium text-gray-700">Width</label>
                            <select
                                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
                                value={widget.layout.w}
                                onChange={e => onUpdate(widget.id, {
                                    layout: { ...widget.layout, w: parseInt(e.target.value) as any }
                                })}
                            >
                                {isSmallWidgetType(widget.type) ? (
                                    <>
                                        <option value={1}>1/4 (Block)</option>
                                    </>
                                ) : (
                                    <>
                                        <option value={2}>1/2 (Default Chart)</option>
                                        <option value={4}>Full Width (4/4)</option>
                                    </>
                                )}
                            </select>
                        </div>
                    </div>
                    {widget.type === 'radial-gauge' && (
                        <div className="space-y-1">
                            <label className="block text-sm font-medium text-gray-700">
                                Gauge Range
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <Input
                                    type="number"
                                    placeholder="Min (default 0)"
                                    value={widget.options?.minValue ?? ''}
                                    onChange={e => onUpdate(widget.id, {
                                        options: {
                                            ...widget.options,
                                            minValue: e.target.value === '' ? undefined : Number(e.target.value)
                                        }
                                    })}
                                />
                                <Input
                                    type="number"
                                    placeholder="Max (default 100)"
                                    value={widget.options?.maxValue ?? ''}
                                    onChange={e => onUpdate(widget.id, {
                                        options: {
                                            ...widget.options,
                                            maxValue: e.target.value === '' ? undefined : Number(e.target.value)
                                        }
                                    })}
                                />
                            </div>
                            <p className="text-xs text-gray-400">
                                Overrides the tag's own range. Leave blank to use the AVEVA
                                Historian engineering-unit range if configured, or 0-100 otherwise
                                — required for TEVE tags, which have no range of their own.
                            </p>
                        </div>
                    )}
                </div>
                <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Tags</label>
                    <TagSelector
                        selectedTags={widget.tags}
                        onChange={tags => onUpdate(widget.id, { tags })}
                        maxTags={5}
                        widgetType={widget.type}
                        className="border shadow-none"
                    />
                </div>
            </CardContent>
        </Card>
    );
};
