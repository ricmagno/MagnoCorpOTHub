import React from 'react';
import Chart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { cn } from '../../utils/cn';
import { tagDisplayName } from '../../utils/tagDisplay';

interface RadialGaugeProps {
    value: number;
    min?: number;
    max?: number;
    tagName: string;
    unit?: string;
    description?: string;
    status?: 'good' | 'bad' | 'uncertain';
    height?: number | string;
    isMaximized?: boolean;
}

export const RadialGauge: React.FC<RadialGaugeProps> = ({
    value = 0,
    min = 0,
    max = 100,
    tagName,
    unit = '',
    description = '',
    status = 'good',
    height = "100%",
    isMaximized = false
}) => {
    const statusIcons = {
        good: 'bg-green-500',
        bad: 'bg-red-500',
        uncertain: 'bg-amber-500'
    };
    // Percentage of the value's position within [min, max]. Shown unclamped in the
    // central number (e.g. "120%") so a value outside the configured range stays
    // visible as an overshoot instead of silently reading "100%" — only the arc
    // fill itself (ApexCharts radialBar) is clamped to a fillable 0-100.
    const range = max - min;
    const percentage = range > 0 ? ((value - min) / range) * 100 : 0;
    const clampedPercentage = Math.min(Math.max(percentage, 0), 100);

    const options: ApexOptions = {
        chart: {
            type: 'radialBar',
            offsetY: -10,
            sparkline: {
                enabled: true
            }
        },
        plotOptions: {
            radialBar: {
                startAngle: -180,
                endAngle: 180,
                hollow: {
                    margin: 0,
                    size: '70%',
                    background: 'transparent',
                },
                track: {
                    background: '#f3f4f6',
                    strokeWidth: '97%',
                    margin: 5,
                },
                dataLabels: {
                    show: false // We use custom overlays for better control and consistency with ValueBlock
                }
            }
        },
        fill: {
            type: 'gradient',
            gradient: {
                shade: 'dark',
                shadeIntensity: 0.15,
                inverseColors: false,
                opacityFrom: 1,
                opacityTo: 1,
                stops: [0, 50, 65, 91],
                colorStops: [
                    {
                        offset: 0,
                        color: "#3b82f6", // Blue
                        opacity: 1
                    },
                    {
                        offset: 60,
                        color: "#10b981", // Green
                        opacity: 1
                    },
                    {
                        offset: 80,
                        color: "#f59e0b", // Amber
                        opacity: 1
                    },
                    {
                        offset: 100,
                        color: "#ef4444", // Red
                        opacity: 1
                    }
                ]
            }
        },
        labels: [tagDisplayName(tagName)],
    };

    const series = [clampedPercentage];

    return (
        <div className="flex flex-col h-full w-full relative">
            {/* Status indicator */}
            <div className={cn(
                "absolute top-3 right-3 rounded-full border-2 border-white shadow-sm z-10",
                isMaximized ? "w-6 h-6 border-4" : "w-3 h-3",
                statusIcons[status]
            )} />

            {/* Gauge ring + centered value overlay share this flexible section so the
                footer below (tag name / range / description) always gets its own,
                un-clipped space instead of being pulled over the ring with a negative
                margin — that overlap trick didn't scale: at full-screen size the ring
                grows far more than the fixed offset compensated for, pushing the
                footer text off the bottom of the viewport. */}
            <div className="relative flex-1 min-h-0">
                {/* Remount on maximize toggle: ApexCharts measures its container once at
                    mount and doesn't re-observe a CSS-driven resize (as opposed to a
                    real window resize event), so it stayed stuck at its small-widget
                    size when maximized without this. */}
                <Chart
                    key={isMaximized ? 'maximized' : 'normal'}
                    options={options}
                    series={series}
                    type="radialBar"
                    height={height}
                    width="100%"
                />

                <div className={cn(
                    "absolute inset-0 flex flex-col items-center justify-center pointer-events-none",
                    !isMaximized && "mt-[-10px]"
                )}>
                    <div className="flex items-baseline justify-center space-x-1">
                        <span className={cn(
                            "font-black tracking-tighter text-gray-900 leading-none",
                            isMaximized ? "text-8xl" : "text-5xl"
                        )}>
                            {percentage.toFixed(1)}
                        </span>
                        <span className={cn(
                            "font-bold text-gray-400",
                            isMaximized ? "text-3xl" : "text-base"
                        )}>
                            %
                        </span>
                    </div>
                    {/* Raw value + unit — the gauge fill and the big number above are both
                        relative to the configured range, so the actual reading is shown
                        here for reference. */}
                    <div className={cn(
                        "font-semibold text-gray-400",
                        isMaximized ? "text-2xl mt-1" : "text-sm mt-0.5"
                    )}>
                        {value.toFixed(1)}{unit ? ` ${unit}` : ''}
                    </div>
                </div>
            </div>

            {/* Footer: tag name, then range, then description — normal flow, so it
                always has its own space and is never clipped or pushed off-screen. */}
            <div className={cn(
                "w-full text-center space-y-1 flex-shrink-0",
                isMaximized ? "pb-10" : "pb-2"
            )}>
                <span className={cn(
                    "font-semibold text-gray-400 truncate max-w-[90%] px-2 block mx-auto",
                    isMaximized ? "text-xl" : "text-[10px]"
                )} title={tagName}>
                    {tagDisplayName(tagName)}
                </span>
                <div className={cn(
                    "text-gray-400 font-medium",
                    isMaximized ? "text-base" : "text-[10px]"
                )}>
                    Range: {min} - {max} {unit}
                </div>
                {description && (
                    <div className={cn(
                        "text-gray-400 font-normal truncate block opacity-70",
                        isMaximized ? "text-lg" : "text-[10px]"
                    )}>
                        {description}
                    </div>
                )}
            </div>
        </div>
    );
};
