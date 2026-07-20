import React, { useMemo } from 'react';
import Chart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { cn } from '../../utils/cn';
import { tagDisplayName } from '../../utils/tagDisplay';

interface NormalDistributionWidgetProps {
    tagName: string;
    /** Mean over the dashboard's configured Time Range (from getStatistics). */
    mean: number;
    /** Standard deviation over the same Time Range. */
    stdDev: number;
    /** Live current value — plotted against the historical distribution above. */
    currentValue: number | null;
    /** Number of samples the mean/stdDev were computed from (0/1 means "not enough data"). */
    sampleCount?: number;
    unit?: string;
    description?: string;
    status?: 'good' | 'bad' | 'uncertain';
    height?: number | string;
    isMaximized?: boolean;
}

const SIGMA_LEVELS = [-3, -2, -1, 1, 2, 3];

function gaussianPdf(x: number, mean: number, stdDev: number): number {
    const coeff = 1 / (stdDev * Math.sqrt(2 * Math.PI));
    const exponent = -0.5 * Math.pow((x - mean) / stdDev, 2);
    return coeff * Math.exp(exponent);
}

/** How far the current value sits from the mean, in standard deviations. */
function zScoreColor(z: number | null): string {
    if (z === null) return '#9ca3af'; // gray — no live value yet
    const abs = Math.abs(z);
    if (abs <= 1) return '#10b981'; // within 1σ — green, normal
    if (abs <= 2) return '#f59e0b'; // 1-2σ — amber, elevated
    return '#ef4444'; // beyond 2σ — red, outlier
}

export const NormalDistributionWidget: React.FC<NormalDistributionWidgetProps> = ({
    tagName,
    mean,
    stdDev,
    currentValue,
    sampleCount = 0,
    unit = '',
    description = '',
    status = 'good',
    height = '100%',
    isMaximized = false
}) => {
    const statusIcons = {
        good: 'bg-green-500',
        bad: 'bg-red-500',
        uncertain: 'bg-amber-500'
    };

    const hasEnoughData = sampleCount >= 2 && stdDev > 0 && Number.isFinite(stdDev);

    const zScore = hasEnoughData && currentValue !== null
        ? (currentValue - mean) / stdDev
        : null;
    const currentColor = zScoreColor(zScore);

    const { series, options } = useMemo((): { series: ApexOptions['series']; options: ApexOptions } => {
        if (!hasEnoughData) {
            return { series: [], options: {} };
        }

        // Curve spans mean ± 4σ (a little past the outermost ±3σ marker for padding).
        const span = stdDev * 4;
        const pointCount = 120;
        const step = (span * 2) / pointCount;
        const curve: Array<{ x: number; y: number }> = [];
        for (let i = 0; i <= pointCount; i++) {
            const x = mean - span + i * step;
            curve.push({ x, y: gaussianPdf(x, mean, stdDev) });
        }

        const sigmaAnnotations = SIGMA_LEVELS.map(level => ({
            x: mean + level * stdDev,
            borderColor: '#cbd5e1',
            strokeDashArray: 3,
            label: {
                text: `${level > 0 ? '+' : ''}${level}σ`,
                orientation: 'horizontal' as const,
                style: { fontSize: '9px', color: '#94a3b8', background: 'transparent' },
                offsetY: -2
            }
        }));

        const meanAnnotation = {
            x: mean,
            borderColor: '#cbd5e1',
            strokeDashArray: 3,
            label: {
                text: 'μ',
                orientation: 'horizontal' as const,
                style: { fontSize: '9px', color: '#94a3b8', background: 'transparent' },
                offsetY: -2
            }
        };

        const currentValueAnnotation = currentValue !== null ? [{
            x: currentValue,
            borderColor: currentColor,
            strokeDashArray: 0,
            borderWidth: 2,
            label: {
                text: 'Now',
                orientation: 'horizontal' as const,
                style: { fontSize: '9px', color: '#fff', background: currentColor, padding: { left: 4, right: 4, top: 1, bottom: 1 } },
                offsetY: -2
            }
        }] : [];

        return {
            series: [{ name: tagName, data: curve.map(p => [p.x, p.y]) }],
            options: {
                chart: {
                    type: 'area',
                    toolbar: { show: false },
                    zoom: { enabled: false },
                    animations: { enabled: false }
                },
                dataLabels: { enabled: false },
                stroke: { curve: 'smooth', width: 2, colors: ['#3b82f6'] },
                fill: {
                    type: 'gradient',
                    gradient: { shadeIntensity: 0.3, opacityFrom: 0.5, opacityTo: 0.05, stops: [0, 100] },
                    colors: ['#3b82f6']
                },
                xaxis: {
                    type: 'numeric',
                    tickAmount: 4,
                    labels: {
                        style: { fontSize: '9px', colors: '#94a3b8' },
                        formatter: (val: string) => Number(val).toFixed(stdDev < 1 ? 2 : 1)
                    },
                    axisBorder: { show: false },
                    axisTicks: { show: false }
                },
                yaxis: { show: false },
                // Left/right padding needs to be wide enough for the outermost annotation
                // labels (-3σ / +3σ, and the x-axis tick text) to clear the card edge — the
                // annotation label text extends past its x-coordinate, so a few px of grid
                // padding alone isn't enough; paired with the container's own px-2 below.
                grid: { show: false, padding: { left: 12, right: 12, top: 20, bottom: 0 } },
                tooltip: { enabled: false },
                annotations: {
                    xaxis: [...sigmaAnnotations, meanAnnotation, ...currentValueAnnotation]
                }
            }
        };
    }, [mean, stdDev, currentValue, hasEnoughData, tagName, currentColor]);

    return (
        <div className="flex flex-col h-full w-full relative">
            {/* Status indicator */}
            <div className={cn(
                "absolute top-3 right-3 rounded-full border-2 border-white shadow-sm z-10",
                isMaximized ? "w-6 h-6 border-4" : "w-3 h-3",
                statusIcons[status]
            )} />

            {!hasEnoughData ? (
                <div className="flex-1 flex items-center justify-center text-center px-4">
                    <p className="text-xs text-gray-400">
                        Not enough historical data in the current Time Range to compute a distribution
                        (need at least 2 samples with some variation).
                    </p>
                </div>
            ) : (
                <div className="flex-1 min-h-0 px-4">
                    <Chart options={options} series={series} type="area" height={height} width="100%" />
                </div>
            )}

            {/* Summary footer: mean, std dev, current value + σ distance */}
            <div className={cn(
                "w-full text-center space-y-0.5 px-2",
                isMaximized ? "pb-6 text-sm" : "pb-2 text-[10px]"
            )}>
                {hasEnoughData && (
                    <div className="flex items-center justify-center gap-3 font-medium text-gray-500">
                        <span>μ {mean.toFixed(2)}{unit}</span>
                        <span>σ {stdDev.toFixed(2)}</span>
                        {currentValue !== null && (
                            <span style={{ color: currentColor }} className="font-bold">
                                Now {currentValue.toFixed(2)}{unit}
                                {zScore !== null && ` (${zScore >= 0 ? '+' : ''}${zScore.toFixed(1)}σ)`}
                            </span>
                        )}
                    </div>
                )}
                <div className={cn("font-semibold text-gray-400 truncate", isMaximized ? "text-base" : "text-[10px]")} title={tagName}>
                    {tagDisplayName(tagName)}
                </div>
                {description && (
                    <div className="text-gray-400 font-normal truncate opacity-70">{description}</div>
                )}
            </div>
        </div>
    );
};
