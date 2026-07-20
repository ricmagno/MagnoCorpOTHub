import React, { useEffect, useRef, useState } from 'react';
import Chart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { cn } from '../../utils/cn';
import { tagDisplayName } from '../../utils/tagDisplay';

interface RadarChartProps {
    data: Record<string, number>;
    title?: string;
    className?: string;
    status?: 'good' | 'bad' | 'uncertain';
    isMaximized?: boolean;
}

export const RadarChart: React.FC<RadarChartProps> = ({
    data,
    title,
    className = '',
    status = 'good',
    isMaximized = false
}) => {
    const statusIcons = {
        good: 'bg-green-500',
        bad: 'bg-red-500',
        uncertain: 'bg-amber-500'
    };

    // ApexCharts' radar plot is inherently circular, sizing its drawing radius
    // off the *smaller* of width/height and leaving the rest as blank space —
    // most cards here are wider than tall (e.g. a half-width widget is 2:1), so
    // without constraining it to a square it renders tiny with dead space on
    // both sides. CSS alone (aspect-ratio wrapper) isn't reliable here: react-
    // apexcharts reads its container's width via width="100%" at mount, and
    // that measurement can race the browser's own aspect-ratio layout pass,
    // silently falling back to ApexCharts' hardcoded 300px default instead of
    // the real size. Measuring directly with ResizeObserver and passing
    // explicit pixel numbers sidesteps the race, and — as a bonus — reacts
    // correctly to the maximize toggle on its own, no forced remount needed.
    const containerRef = useRef<HTMLDivElement>(null);
    const [squareSize, setSquareSize] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => {
            const { width, height } = el.getBoundingClientRect();
            setSquareSize(Math.floor(Math.min(width, height)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const rawTags = Object.keys(data);
    // Full tag names, not truncated — the card is now sized square off its own
    // width (see the Widget.tsx radar exception), giving axis labels real room.
    const categories = rawTags.map(tag => tagDisplayName(tag));
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

            <div ref={containerRef} className="h-full w-full flex items-center justify-center">
                {squareSize > 0 && (
                    <Chart
                        options={options}
                        series={series}
                        type="radar"
                        height={squareSize*1}
                        width={squareSize*1}
                    />
                )}
            </div>

            {title && (
                <span className="sr-only">{title}</span>
            )}
        </div>
    );
};
