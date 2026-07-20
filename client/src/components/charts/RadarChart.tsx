import React from 'react';
import Chart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { cn } from '../../utils/cn';
import { tagDisplayName } from '../../utils/tagDisplay';

interface RadarChartProps {
    data: Record<string, number>;
    title?: string;
    height?: number | string;
    className?: string;
    status?: 'good' | 'bad' | 'uncertain';
    isMaximized?: boolean;
}

// Axis category labels are raw tag names, some of which (full OPC UA node IDs)
// run 30-40+ chars — ApexCharts shrinks the polygon to make room for whatever
// space the labels need, so long labels were crushing the plot down to a few
// pixels. Truncating keeps the shape readable; the full name is still on the
// card's tooltip/title via the underlying (untruncated) data.
function shortAxisLabel(tagName: string, maxLen = 16): string {
    const display = tagDisplayName(tagName);
    return display.length > maxLen ? `${display.slice(0, maxLen - 1)}…` : display;
}

export const RadarChart: React.FC<RadarChartProps> = ({
    data,
    title,
    height = '100%',
    className = '',
    status = 'good',
    isMaximized = false
}) => {
    const statusIcons = {
        good: 'bg-green-500',
        bad: 'bg-red-500',
        uncertain: 'bg-amber-500'
    };

    const rawTags = Object.keys(data);
    const categories = rawTags.map(tag => shortAxisLabel(tag, isMaximized ? 24 : 16));
    const series = [{
        name: 'Value',
        data: Object.values(data),
    }];

    const options: ApexOptions = {
        chart: {
            type: 'radar',
            toolbar: {
                show: false
            },
            // No dropShadow — it bled onto the axis (tag name) labels, giving them
            // a blurry double-outline that none of the other widgets have.
        },
        stroke: {
            width: 2,
            colors: ['#3b82f6'] // Blue-500
        },
        fill: {
            opacity: 0.2,
            colors: ['#3b82f6']
        },
        markers: {
            size: 4,
            colors: ['#fff'],
            strokeColors: '#3b82f6',
            strokeWidth: 2,
        },
        xaxis: {
            categories: categories,
            labels: {
                style: {
                    colors: Array(categories.length).fill('#6b7280'),
                    fontSize: isMaximized ? '13px' : '10px',
                }
            }
        },
        yaxis: {
            show: false,
        },
        legend: {
            show: false
        },
        tooltip: {
            y: {
                // Full untruncated tag name in the tooltip, since the axis label
                // itself may be cut short.
                title: {
                    formatter: (_seriesName: string, opts: any) => tagDisplayName(rawTags[opts.dataPointIndex] || '')
                }
            }
        }
    };

    return (
        <div className={cn("bg-white p-2 h-full w-full relative", className)}>
            {/* Status indicator */}
            <div className={cn(
                "absolute top-3 right-3 rounded-full border-2 border-white shadow-sm z-10",
                isMaximized ? "w-6 h-6 border-4" : "w-3 h-3",
                statusIcons[status]
            )} />

            {/* ApexCharts sizes itself once at mount and doesn't re-observe container
                resizes from a CSS-driven change (as opposed to a real window resize
                event) — remounting on maximize toggle forces it to measure the new,
                much larger container instead of staying stuck at its original size. */}
            <Chart
                key={isMaximized ? 'maximized' : 'normal'}
                options={options}
                series={series}
                type="radar"
                height={height}
                width="100%"
            />

            {title && (
                <span className="sr-only">{title}</span>
            )}
        </div>
    );
};
