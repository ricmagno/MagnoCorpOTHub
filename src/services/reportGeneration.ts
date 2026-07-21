/**
 * Report Generation Service
 * Handles PDF generation with PDFKit, templating with Handlebars, and chart embedding
 * Requirements: 4.1, 4.3, 4.4, 4.5
 */

import PDFDocument from 'pdfkit';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';
import { TimeSeriesData, StatisticsResult, TrendResult, SPCMetricsSummary, SpecificationLimits, TagClassification, TagInfo } from '@/types/historian';
import { reportLogger } from '@/utils/logger';
import { createError } from '@/middleware/errorHandler';
import { env } from '@/config/environment';
import { chartGenerationService } from './chartGeneration';
import { brandingService } from './brandingService';
import { chartBufferValidator } from '@/utils/chartBufferValidator';
import { generateReportFilename, getReportNameFromConfig } from '@/utils/reportFilename';
import { classifyTag, classifyTags } from './tagClassificationService';
import { statisticalAnalysisService } from './statisticalAnalysis';
import { analyticsErrorHandler } from '@/utils/analyticsErrorHandler';

// Import package.json for version info
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

// ── PDF design tokens ─────────────────────────────────────────────────────────
// "Engineering record" direction: drawing-title-block cover, numbered sections,
// mono (Courier) data values, brand primary reserved for structural accents.
const M = 40;                       // page side margin
const INK = '#111827';              // primary text
const MUTED = '#6b7280';            // secondary text
const FAINT = '#9ca3af';            // tertiary text
const RULE = '#e5e7eb';             // hairline rules
const PANEL = '#f8fafc';            // panel/card fill
const BODY = '#374151';             // body copy

/** Usable content width between the side margins. */
const contentW = (doc: PDFKit.PDFDocument): number => doc.page.width - M * 2;

/** Uppercase, letter-spaced eyebrow label — the report's recurring structural voice. */
const eyebrow = (doc: PDFKit.PDFDocument, text: string, x: number, y: number, color: string, size = 6.5): void => {
  doc.fontSize(size).font('Helvetica-Bold').fillColor(color)
    .text(text.toUpperCase(), x, y, { characterSpacing: 1.4, lineBreak: false });
};

export interface ReportConfig {
  id: string;
  name: string;
  description?: string | undefined;
  tags: string[];
  timeRange: {
    startTime: Date;
    endTime: Date;
    relativeRange?: 'last1h' | 'last2h' | 'last6h' | 'last12h' | 'last24h' | 'last7d' | 'last30d' | undefined;
    timezone?: string | undefined;
  };
  chartTypes: ('line' | 'bar' | 'trend' | 'scatter')[];
  template: string;
  format: 'pdf' | 'docx';
  branding?: {
    companyName?: string | undefined;
    logo?: string | undefined;
    colors?: {
      primary?: string | undefined;
      secondary?: string | undefined;
    } | undefined;
  } | undefined;
  metadata?: {
    author?: string | undefined;
    subject?: string | undefined;
    keywords?: string[] | undefined;
  } | undefined;
  specificationLimits?: Record<string, SpecificationLimits> | undefined;
  includeSPCCharts?: boolean | undefined;
  includeTrendLines?: boolean | undefined;
  includeMultiTrend?: boolean | undefined;
  includeStatsSummary?: boolean | undefined;
  includeDataTable?: boolean | undefined;
  version?: number | undefined;
  retrievalMode?: string | undefined;
  advancedFilters?: any | undefined;
}

export interface ReportData {
  config: ReportConfig;
  data: Record<string, TimeSeriesData[]>;
  statistics?: Record<string, StatisticsResult>;
  trends?: Record<string, TrendResult>;
  charts?: Record<string, Buffer>;
  tagInfo?: Record<string, TagInfo>;
  generatedAt: Date;
}

export interface ReportResult {
  success: boolean;
  reportId: string;
  filePath?: string;
  buffer?: Buffer;
  metadata: {
    pages: number;
    fileSize: number;
    format: string;
    generationTime: number;
  };
  error?: string;
}

export class ReportGenerationService {
  private templatesDir: string;
  private outputDir: string;

  constructor() {
    this.templatesDir = path.join(process.cwd(), 'templates');
    this.outputDir = env.REPORTS_DIR || './reports';
    this.ensureDirectories();
    this.registerHandlebarsHelpers();
  }

  /**
   * Generate a PDF report
   */
  async generateReport(reportData: ReportData): Promise<ReportResult> {
    const startTime = Date.now();

    try {
      reportLogger.info('Starting report generation', {
        reportId: reportData.config.id,
        format: reportData.config.format
      });

      // Generate charts if requested
      if (reportData.config.chartTypes.length > 0 && !reportData.charts) {
        reportLogger.info('Generating charts for report', {
          chartTypes: reportData.config.chartTypes
        });

        reportData.charts = await chartGenerationService.generateReportCharts(
          reportData.data,
          reportData.statistics,
          reportData.trends,
          reportData.config.chartTypes,
          { timezone: reportData.config.timeRange.timezone }
        );
      }

      if (reportData.config.format === 'pdf') {
        return await this.generatePDFReport(reportData, startTime);
      } else if (reportData.config.format === 'docx') {
        // TODO: Implement DOCX generation
        throw createError('DOCX format not yet implemented', 501);
      } else {
        throw createError('Unsupported report format', 400);
      }
    } catch (error) {
      reportLogger.error('Report generation failed', {
        reportId: reportData.config.id,
        error
      });

      return {
        success: false,
        reportId: reportData.config.id,
        metadata: {
          pages: 0,
          fileSize: 0,
          format: reportData.config.format,
          generationTime: Date.now() - startTime
        },
        error: error instanceof Error ? error.stack || error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate PDF report using PDFKit
   */
  private async generatePDFReport(reportData: ReportData, startTime: number): Promise<ReportResult> {
    return new Promise(async (resolve, reject) => {
      try {
        // Step 1: Classify tags (analog vs digital)
        reportLogger.info('Classifying tags for analytics', {
          tagCount: Object.keys(reportData.data).length
        });

        const tagClassifications = new Map<string, TagClassification>();
        for (const [tagName, data] of Object.entries(reportData.data)) {
          if (data.length > 0) {
            const classification = classifyTag(data);
            tagClassifications.set(tagName, classification);
            reportLogger.debug(`Tag ${tagName} classified as ${classification.type}`, {
              confidence: classification.confidence
            });
          }
        }

        // Step 2: Calculate analytics for analog tags
        const trendLines = new Map<string, any>();
        const spcMetrics = new Map<string, any>();
        const spcMetricsSummary: SPCMetricsSummary[] = [];

        const includeTrendLines = reportData.config.includeTrendLines !== false; // Default: true
        const includeStatsSummary = reportData.config.includeStatsSummary !== false; // Default: true
        const includeSPCCharts = !!reportData.config.includeSPCCharts; // Default: false
        const includeDataTable = !!reportData.config.includeDataTable; // Default: false

        reportLogger.info('PDF Generation configuration', {
          reportId: reportData.config.id,
          includeTrendLines,
          includeSPCCharts,
          includeStatsSummary,
          includeDataTable,
          hasStatistics: !!reportData.statistics && Object.keys(reportData.statistics).length > 0
        });

        for (const [tagName, data] of Object.entries(reportData.data)) {
          const classification = tagClassifications.get(tagName);

          // Only process analog tags
          if (classification?.type === 'analog' && data.length >= 3) {
            // Calculate trend line if enabled (with graceful error handling)
            if (includeTrendLines) {
              const trendLine = statisticalAnalysisService.safeCalculateTrendLine(data, tagName);
              if (trendLine) {
                trendLines.set(tagName, trendLine);
                reportLogger.debug(`Trend line calculated for ${tagName}`, {
                  slope: trendLine.slope,
                  rSquared: trendLine.rSquared
                });
              } else {
                reportLogger.warn(`Trend line calculation failed for ${tagName}, continuing without trend line`);
              }
            }

            // Calculate SPC metrics if enabled and spec limits provided (with graceful error handling)
            if (includeSPCCharts) {
              const specLimits = reportData.config.specificationLimits?.[tagName];
              const metrics = statisticalAnalysisService.safeCalculateSPCMetrics(data, tagName, specLimits);

              if (metrics) {
                spcMetrics.set(tagName, metrics);

                // Add to summary table
                const capability = statisticalAnalysisService.assessCapability(metrics.cp, metrics.cpk);
                spcMetricsSummary.push({
                  tagName,
                  mean: metrics.mean,
                  stdDev: metrics.stdDev,
                  ucl: metrics.ucl,
                  lcl: metrics.lcl,
                  lsl: specLimits?.lsl ?? null,
                  usl: specLimits?.usl ?? null,
                  cp: metrics.cp,
                  cpk: metrics.cpk,
                  capability
                });

                reportLogger.debug(`SPC metrics calculated for ${tagName}`, {
                  mean: metrics.mean,
                  cp: metrics.cp,
                  cpk: metrics.cpk,
                  capability
                });
              } else {
                reportLogger.warn(`SPC metrics calculation failed for ${tagName}, continuing without SPC metrics`);
              }
            }
          }
        }

        // Step 3: Generate enhanced charts with trend lines and statistics
        const enhancedCharts = new Map<string, Buffer>();

        // Pre-populate with WYSIWYG charts from frontend
        if (reportData.charts) {
          for (const [chartName, chartBuffer] of Object.entries(reportData.charts)) {
            enhancedCharts.set(chartName, chartBuffer);
            reportLogger.debug(`Using pre-generated WYSIWYG chart: ${chartName}`);
          }
        }

        // ALWAYS generate the Multi-Trend Chart in the backend if missing or to ensure legend presence
        const shouldIncludeMultiTrend = reportData.config.includeMultiTrend !== false;
        if (shouldIncludeMultiTrend && (!enhancedCharts.has('Multi-Trend Chart') || true)) { // Force backend generation for legendary reliability
          const analogDatasets: any[] = [];
          for (const [tagName, data] of Object.entries(reportData.data)) {
            const classification = tagClassifications.get(tagName);
            if (classification?.type === 'analog' && data.length > 0) {
              analogDatasets.push({
                tagName,
                data,
                trendLine: trendLines.get(tagName),
                statistics: reportData.statistics?.[tagName] ? {
                  min: reportData.statistics[tagName].min,
                  max: reportData.statistics[tagName].max,
                  mean: reportData.statistics[tagName].average,
                  stdDev: reportData.statistics[tagName].standardDeviation
                } : undefined,
                color: chartGenerationService.getStableTagColor(tagName, reportData.config.tags)
              });
            }
          }

          if (analogDatasets.length > 0) {
            try {
              const multiTrendBuffer = await chartGenerationService.generateLineChart(
                analogDatasets,
                {
                  title: 'Combined Process Trends',
                  width: 1200,
                  height: 600,
                  timezone: reportData.config.timeRange.timezone,
                  includeTrendLines: includeTrendLines,
                  tags: reportData.config.tags,
                  showLegend: true
                }
              );
              enhancedCharts.set('Multi-Trend Chart', multiTrendBuffer);
              reportLogger.info('Generated Multi-Trend Chart in backend');
            } catch (error) {
              reportLogger.error('Failed to generate multi-trend chart in backend', { error });
            }
          }
        }

        for (const [tagName, data] of Object.entries(reportData.data)) {
          if (data.length === 0) continue;

          const classification = tagClassifications.get(tagName);
          const stats = reportData.statistics?.[tagName];

          // Generate standard chart with trend line and statistics if NOT provided by frontend
          const hasFrontendChart = Array.from(enhancedCharts.keys()).some(k => k === tagName || k.startsWith(`${tagName} - `));

          // if (!hasFrontendChart) {
          //   const trendLine = trendLines.get(tagName);
          //   const statistics = stats ? {
          //     min: stats.min,
          //     max: stats.max,
          //     mean: stats.average,
          //     stdDev: stats.standardDeviation
          //   } : undefined;

          //   const lineChartData: any = {
          //     tagName,
          //     data,
          //     trendLine,
          //     statistics
          //   };

          //   try {
          //     const chartBuffer = await chartGenerationService.generateLineChart(
          //       [lineChartData],
          //       {
          //         // Removed internal title to match frontend "captured" SVG look
          //         width: 1200,
          //         height: 600,
          //         timezone: reportData.config.timeRange.timezone,
          //         includeTrendLines: includeTrendLines
          if (!hasFrontendChart) {
            const trendLine = trendLines.get(tagName);
            const statistics = stats ? {
              min: stats.min,
              max: stats.max,
              mean: stats.average,
              stdDev: stats.standardDeviation
            } : undefined;

            const lineChartData: any = {
              tagName,
              data,
              trendLine,
              statistics
            };

            try {
              const chartBuffer = await chartGenerationService.generateLineChart(
                [lineChartData],
                {
                  // Used 1200x530 to match the 2.26 aspect ratio of the PDF slots (521x230)
                  width: 1200,
                  height: 530,
                  timezone: reportData.config.timeRange.timezone,
                  includeTrendLines: includeTrendLines,
                  tags: reportData.config.tags
                }
              );

              enhancedCharts.set(`${tagName} - Data Trend`, chartBuffer);
              reportLogger.debug(`Enhanced chart generated for ${tagName}`);
            } catch (error) {
              reportLogger.error(`Failed to generate line chart for ${tagName}`, {
                error: error instanceof Error ? error.message : 'Unknown error'
              });
              // Chart generation failed - report will continue without this chart
              // The addChartsSection method will handle missing charts gracefully
            }
          }

          // Generate SPC chart for analog tags if enabled
          if (classification?.type === 'analog' && includeSPCCharts) {
            const metrics = spcMetrics.get(tagName);
            const specLimits = reportData.config.specificationLimits?.[tagName];

            if (metrics) {
              try {
                // No internal chart title — the PDF card header already names the
                // tag, and a second title inside the plot reads as a duplicate.
                const spcChartBuffer = await chartGenerationService.generateSPCChart(
                  tagName,
                  data,
                  metrics,
                  specLimits,
                  {
                    width: 1200,
                    height: 530, // Match 2.26 aspect ratio
                    timezone: reportData.config.timeRange.timezone
                  }
                );

                enhancedCharts.set(`${tagName} - SPC Chart`, spcChartBuffer);
                reportLogger.debug(`SPC chart generated for ${tagName}`);
              } catch (error) {
                reportLogger.error(`Failed to generate SPC chart for ${tagName}`, {
                  error: error instanceof Error ? error.message : 'Unknown error'
                });
                // SPC chart generation failed - report will continue without this chart
              }
            }
          }
        }

        // Step 4: Create PDF document
        const doc = new PDFDocument({
          size: 'A4',
          margins: { top: 70, bottom: 50, left: M, right: M },
          bufferPages: true, // Enable page buffering for footer addition
          info: {
            Title: reportData.config.name,
            Author: reportData.config.metadata?.author || brandingService.getDisplayName(),
            Subject: reportData.config.metadata?.subject || reportData.config.description || '',
            Keywords: reportData.config.metadata?.keywords?.join(', ') || '',
            Creator: `${brandingService.getDisplayName()} Application`,
            Producer: 'PDFKit'
          }
        });

        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(chunk));

        // Add error handler for the document
        doc.on('error', (error) => {
          reject(error);
        });

        // Cover page: branding header, title, engineering title block, summary, findings
        this.addReportHeader(doc, reportData.config);
        this.addReportTitle(doc, reportData.config);
        this.addReportMetadata(doc, reportData);
        this.addExecutiveSummary(doc, reportData);
        this.addKeyFindings(doc, reportData);

        // Sections are numbered in order of inclusion; each starts on a fresh page
        // (page break at section START, so the document never ends on a blank page).
        let sectionNum = 0;

        // *** Section Information (only displayed if option Statistics Summary is selected)
        if (includeStatsSummary && reportData.statistics) {
          doc.addPage();
          this.addSectionHeader(doc, ++sectionNum, 'Statistics Summary');
          this.addStatisticalSummary(doc, reportData.statistics);
        }

        // *** Section Data visualization (ALWAYS DISPLAYED)
        doc.addPage();
        this.addSectionHeader(doc, ++sectionNum, 'Data Visualization');

        // Separate SPC charts to be used in Section Statistical Process Control Analysis later
        const spcCharts = new Map<string, Buffer>();
        for (const [chartName, chartBuffer] of enhancedCharts.entries()) {
          if (chartName.includes('SPC Chart')) {
            spcCharts.set(chartName, chartBuffer);
          }
        }

        // 1. Multi-Trend Overview Chart (Requirement: provide comparative view first)
        const includeMultiTrendFlag = reportData.config.includeMultiTrend ?? true;
        const multiTrendBuffer = includeMultiTrendFlag ? enhancedCharts.get('Multi-Trend Chart') : undefined;

        if (multiTrendBuffer) {
          doc.fontSize(12).fillColor(BODY).font('Helvetica-Bold').text('Combined Process Trends', M);
          doc.moveDown(0.5);

          const fullChartWidth = contentW(doc);
          const fullChartHeight = 320;

          try {
            const bufferInfo = chartBufferValidator.getBufferInfo(multiTrendBuffer);
            if (bufferInfo.format === 'SVG') {
              const rawSvg = multiTrendBuffer.toString('utf8');
              const svgString = rawSvg.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, '');
              const SVGtoPDF = require('svg-to-pdfkit');
              SVGtoPDF(doc, svgString, M, doc.y, {
                width: fullChartWidth,
                height: fullChartHeight,
                preserveAspectRatio: 'xMidYMid meet'
              });
            } else {
              doc.image(multiTrendBuffer, M, doc.y, {
                fit: [fullChartWidth, fullChartHeight],
                align: 'center',
                valign: 'center'
              });
            }
            doc.y += fullChartHeight + 40;
          } catch (error) {
            reportLogger.error('Failed to embed multi-trend overview chart', { error });
          }

          // Move to new page for individual tag breakdown
          doc.addPage();
        }

        // 2. Individual Tag Charts - Replicates the MiniChart view from Report Preview
        let chartCount = 0;
        for (const tagName of reportData.config.tags) {
          // Priority: Use the SVG captured from the frontend for total WYSIWYG
          let chartBuffer = enhancedCharts.get(tagName);

          if (!chartBuffer) {
            // Fallback to generated line chart if no WYSIWYG chart for this tag
            chartBuffer = enhancedCharts.get(`${tagName} - Data Trend`);
          }

          if (chartBuffer) {
            // Logic for 2 charts per page (matching preview density)
            if (chartCount > 0 && chartCount % 2 === 0) {
              doc.addPage();
            }

            const stats = reportData.statistics?.[tagName];
            const trend = reportData.trends?.[tagName];
            const tagInfo = reportData.tagInfo?.[tagName];

            this.addMiniChart(
              doc,
              tagName,
              chartBuffer,
              tagInfo?.description,
              stats,
              trend
            );

            chartCount++;
          }
        }

        // Trend lines are now overlaid directly on charts in the Data Visualization section,
        // so a separate Trend Analysis section is no longer needed.

        // *** Section Statistical Process Control Analysis
        if (includeSPCCharts && (spcCharts.size > 0 || spcMetricsSummary.length > 0)) {
          doc.addPage();
          this.addSectionHeader(doc, ++sectionNum, 'Statistical Process Control');

          // 2 charts per page logic for SPC charts
          let spcChartIdx = 0;
          for (const tagName of reportData.config.tags) {
            const chartBuffer = enhancedCharts.get(`${tagName} - SPC Chart`);
            if (chartBuffer) {
              if (spcChartIdx > 0 && spcChartIdx % 2 === 0) {
                doc.addPage();
              }

              const metrics = spcMetrics.get(tagName);
              const specLimits = reportData.config.specificationLimits?.[tagName];

              this.addSPCChart(doc, tagName, chartBuffer, metrics, specLimits);
              spcChartIdx++;
            }
          }

          if (spcMetricsSummary.length > 0) {
            if (doc.y > doc.page.height - 300) {
              doc.addPage();
            } else {
              doc.moveDown(1);
            }
            this.addSPCMetricsTable(doc, spcMetricsSummary);
          }
        }

        // *** Section Data table (only displayed if Includes Data Table is selected)
        if (reportData.config.includeDataTable) {
          let firstTable = true;
          for (const [tagName, data] of Object.entries(reportData.data)) {
            if (data.length > 0) {
              doc.addPage();
              if (firstTable) {
                this.addSectionHeader(doc, ++sectionNum, 'Data Table');
                firstTable = false;
              }
              this.addDataTable(doc, tagName, data);
            }
          }
        }

        // Get page count before adding footers
        const pageCount = doc.bufferedPageRange().count;

        // Add footer to all pages (must be done before doc.end())
        this.addReportFooter(doc, reportData);

        // Finalize the PDF
        doc.end();

        doc.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);

            // Generate standardized filename using report name and current date/timezone
            const reportName = getReportNameFromConfig(reportData.config);
            const baseFileName = generateReportFilename(
              reportName,
              'pdf',
              reportData.generatedAt,
              reportData.config.timeRange?.timezone
            );

            // Use a subdirectory for each report ID to keep filenames clean 
            // while maintaining uniqueness and allowing the download route to find them.
            const reportDir = path.join(this.outputDir, reportData.config.id);
            if (!fs.existsSync(reportDir)) {
              fs.mkdirSync(reportDir, { recursive: true });
            }

            const filePath = path.join(reportDir, baseFileName);

            // Save to file
            fs.writeFileSync(filePath, buffer);

            const result: ReportResult = {
              success: true,
              reportId: reportData.config.id,
              filePath,
              buffer,
              metadata: {
                pages: pageCount,
                fileSize: buffer.length,
                format: 'pdf',
                generationTime: Date.now() - startTime
              }
            };

            // Log analytics error summary if any errors occurred
            if (analyticsErrorHandler.hasErrors()) {
              const errorSummary = analyticsErrorHandler.getErrorSummary();
              reportLogger.warn('Report generated with analytics errors', {
                reportId: reportData.config.id,
                errorSummary,
                errors: analyticsErrorHandler.getErrors().map(e => ({
                  type: e.type,
                  message: e.message,
                  tagName: e.tagName,
                  metric: e.metric
                }))
              });

              // Clear errors for next report
              analyticsErrorHandler.clearErrors();
            }

            reportLogger.info('PDF report generated successfully with analytics', {
              reportId: reportData.config.id,
              filePath,
              fileSize: buffer.length,
              pages: result.metadata.pages,
              generationTime: result.metadata.generationTime,
              analogTags: Array.from(tagClassifications.values()).filter(c => c.type === 'analog').length,
              digitalTags: Array.from(tagClassifications.values()).filter(c => c.type === 'digital').length,
              trendLinesGenerated: trendLines.size,
              spcChartsGenerated: spcMetrics.size
            });

            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Add report header with branding
   */
  private addReportHeader(doc: PDFKit.PDFDocument, config: ReportConfig): void {
    const globalBranding = brandingService.getSettings();
    const companyName = config.branding?.companyName || globalBranding.companyName || 'MagnoCorpOTHub';
    const appName = globalBranding.appName || 'MagnoCorpOTHub';

    // Brand accent bar — the first thing a reader sees, so this is the highest-
    // visibility place to reflect the configured primary color.
    doc.rect(0, 0, doc.page.width, 4).fill(globalBranding.primaryColor);

    doc.fontSize(16)
      .fillColor(INK)
      .font('Helvetica-Bold')
      .text(companyName, M, 24);

    eyebrow(doc, appName, M, 46, MUTED, 7);

    // Logo: per-report override first, then global logo
    const logoData = config.branding?.logo || brandingService.getLogo();
    if (logoData) {
      try {
        const b64 = logoData.includes(',') ? (logoData.split(',')[1] ?? logoData) : logoData;
        const logoBuffer = Buffer.from(b64, 'base64');
        doc.image(logoBuffer, doc.page.width - M - 60, 24, { width: 60 });
      } catch (error) {
        reportLogger.warn('Failed to embed logo from base64 string', { error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    // Horizontal line below header
    doc.strokeColor(RULE)
      .lineWidth(0.5)
      .moveTo(M, 70)
      .lineTo(doc.page.width - M, 70)
      .stroke();

    doc.y = 88;
    doc.fillColor(INK);
    doc.x = M;
  }

  /**
   * Numbered section header: eyebrow ("SECTION 01"), title, hairline rule.
   * Every section opens with this so the document reads as one system.
   */
  private addSectionHeader(doc: PDFKit.PDFDocument, num: number, title: string): void {
    const { primaryColor } = brandingService.getSettings();
    const y = doc.y;

    eyebrow(doc, `Section ${String(num).padStart(2, '0')}`, M, y, primaryColor);

    doc.fontSize(18)
      .fillColor(INK)
      .font('Helvetica-Bold')
      .text(title, M, y + 12);

    const ruleY = doc.y + 6;
    doc.strokeColor(RULE).lineWidth(0.5)
      .moveTo(M, ruleY).lineTo(doc.page.width - M, ruleY).stroke();

    doc.y = ruleY + 16;
    doc.x = M;
    doc.fillColor(INK);
  }

  /**
   * Add report title (name + description).
   */
  private addReportTitle(doc: PDFKit.PDFDocument, config: ReportConfig): void {
    const { primaryColor } = brandingService.getSettings();

    eyebrow(doc, 'Process History Report', M, doc.y, primaryColor);
    doc.y += 12;

    doc.fontSize(26)
      .fillColor(INK)
      .font('Helvetica-Bold')
      .text(config.name, M, doc.y, { width: contentW(doc) });

    if (config.version) {
      doc.moveDown(0.15);
      doc.fontSize(9).fillColor(FAINT).font('Helvetica')
        .text(`Revision ${config.version}`, M);
    }

    if (config.description) {
      doc.moveDown(0.4);
      doc.fontSize(11)
        .fillColor(MUTED)
        .font('Helvetica')
        .text(config.description, M, doc.y, { width: contentW(doc) });
    }

    doc.moveDown(1.2);
    doc.fillColor(INK);
    doc.x = M;
  }

  /**
   * Add compact metadata strip.
   */
  private addReportMetadata(doc: PDFKit.PDFDocument, reportData: ReportData): void {
    const { config } = reportData;
    const tz = config.timeRange.timezone || env.DEFAULT_TIMEZONE;

    const formatOptions: Intl.DateTimeFormatOptions = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: tz
    };

    const fmt = (d: Date | unknown) =>
      d instanceof Date ? d.toLocaleString('en-US', formatOptions) : 'Unknown';

    const totalPoints = Object.values(reportData.data).reduce((s, d) => s + d.length, 0);

    // ── Title block ──────────────────────────────────────────────────────────
    // Modeled on an engineering drawing's title block: a ruled grid of labeled
    // fields that makes the report's provenance auditable at a glance.
    const w = contentW(doc);
    const blockX = M;
    const blockY = doc.y;
    const rowH = 34;

    type Cell = { label: string; value: string };
    const rows: Cell[][] = [
      [
        { label: 'Report Period', value: `${fmt(config.timeRange.startTime)} — ${fmt(config.timeRange.endTime)}` },
        { label: 'Timezone', value: tz },
        { label: 'Retrieval Mode', value: config.retrievalMode || 'Delta' }
      ],
      [
        { label: 'Generated', value: fmt(reportData.generatedAt) },
        { label: 'Tags', value: String(config.tags.length) },
        { label: 'Data Points', value: totalPoints.toLocaleString() }
      ]
    ];
    // First column is wide (timestamps), the two others split the remainder.
    const colW = [w * 0.5, w * 0.25, w * 0.25];

    const drawCell = (cell: Cell, x: number, y: number, width: number): void => {
      eyebrow(doc, cell.label, x + 8, y + 7, MUTED);
      doc.fontSize(8.5).font('Courier-Bold').fillColor(INK)
        .text(cell.value, x + 8, y + 17, { width: width - 16, lineBreak: false });
    };

    rows.forEach((row, r) => {
      let x = blockX;
      row.forEach((cell, c) => {
        drawCell(cell, x, blockY + r * rowH, colW[c]!);
        x += colW[c]!;
      });
    });

    // Tag list row — full width, wraps, mono. Height depends on content.
    const tagListY = blockY + rows.length * rowH;
    const tagList = config.tags.join('   ');
    doc.fontSize(7.5).font('Courier');
    const tagListH = doc.heightOfString(tagList, { width: w - 16 }) + 22;

    eyebrow(doc, 'Monitoring Tags', blockX + 8, tagListY + 7, MUTED);
    doc.fontSize(7.5).font('Courier').fillColor(BODY)
      .text(tagList, blockX + 8, tagListY + 17, { width: w - 16 });

    const blockH = rows.length * rowH + tagListH;

    // Grid lines: outer border, horizontal rules, vertical dividers on field rows.
    doc.lineWidth(0.5).strokeColor(RULE);
    doc.rect(blockX, blockY, w, blockH).stroke();
    for (let r = 1; r <= rows.length; r++) {
      doc.moveTo(blockX, blockY + r * rowH).lineTo(blockX + w, blockY + r * rowH).stroke();
    }
    for (let r = 0; r < rows.length; r++) {
      let x = blockX;
      for (let c = 0; c < colW.length - 1; c++) {
        x += colW[c]!;
        doc.moveTo(x, blockY + r * rowH).lineTo(x, blockY + (r + 1) * rowH).stroke();
      }
    }

    doc.y = blockY + blockH + 24;
    doc.fillColor(INK);
    doc.x = M;
  }

  /**
   * Add executive summary paragraph.
   */
  private addExecutiveSummary(doc: PDFKit.PDFDocument, reportData: ReportData): void {
    const totalTags = reportData.config.tags.length;
    const totalDataPoints = Object.values(reportData.data).reduce((sum, data) => sum + data.length, 0);

    // Overall data quality across all tags, when statistics are available.
    const qualities = Object.values(reportData.statistics || {})
      .map(s => s.dataQuality)
      .filter((q): q is number => typeof q === 'number' && !isNaN(q));
    const qualityClause = qualities.length > 0
      ? ` Overall data quality across all tags is ${(qualities.reduce((a, b) => a + b, 0) / qualities.length).toFixed(1)}%.`
      : '';

    const summaryText =
      `This report analyses ${totalTags} monitoring point${totalTags === 1 ? '' : 's'} over the configured ` +
      `time period, covering ${totalDataPoints.toLocaleString()} data points in total.${qualityClause}`;

    doc.fontSize(13).fillColor(INK).font('Helvetica-Bold').text('Executive Summary', M);
    doc.moveDown(0.4);
    doc.fontSize(10.5).fillColor(BODY).font('Helvetica').text(summaryText, M, doc.y, { width: contentW(doc) });
    doc.moveDown(1.2);
  }

  /**
   * Add key findings: one computed line per tag (mean, range, trend direction,
   * quality flag) instead of boilerplate that repeats the executive summary.
   */
  private addKeyFindings(doc: PDFKit.PDFDocument, reportData: ReportData): void {
    const { primaryColor } = brandingService.getSettings();
    const maxTags = 8;
    const findings: Array<{ tag: string; text: string }> = [];

    for (const tagName of reportData.config.tags.slice(0, maxTags)) {
      const stats = reportData.statistics?.[tagName];
      if (!stats) continue;

      const parts: string[] = [];
      parts.push(`averaged ${this.formatValue(stats.average, 1)} (range ${this.formatValue(stats.min, 1)} to ${this.formatValue(stats.max, 1)})`);

      const trend = reportData.trends?.[tagName];
      if (trend && typeof trend.slope === 'number') {
        const perMin = trend.slope * 60000;
        const direction = perMin > 0 ? 'rising' : perMin < 0 ? 'falling' : 'flat';
        parts.push(`trend ${direction} at ${perMin >= 0 ? '+' : ''}${perMin.toFixed(4)}/min`);
      }

      if (typeof stats.dataQuality === 'number') {
        parts.push(stats.dataQuality >= 90
          ? `data quality ${stats.dataQuality.toFixed(1)}%`
          : `data quality only ${stats.dataQuality.toFixed(1)}% — review source`);
      }

      findings.push({ tag: tagName, text: parts.join('; ') + '.' });
    }

    if (findings.length === 0) return;

    doc.fontSize(13).fillColor(INK).font('Helvetica-Bold').text('Key Findings', M, doc.y);
    doc.moveDown(0.5);

    for (const finding of findings) {
      const rowY = doc.y;
      // Small square marker in the brand primary — quieter than a bullet glyph.
      doc.rect(M + 1, rowY + 3, 4, 4).fill(primaryColor);

      doc.fontSize(9.5).font('Courier-Bold').fillColor(INK)
        .text(finding.tag, M + 14, rowY, { width: contentW(doc) - 14 });
      doc.fontSize(9.5).font('Helvetica').fillColor(BODY)
        .text(finding.text, M + 14, doc.y + 1, { width: contentW(doc) - 14 });
      doc.moveDown(0.6);
    }

    if (reportData.config.tags.length > maxTags) {
      doc.fontSize(8.5).fillColor(FAINT).font('Helvetica')
        .text(`Findings shown for the first ${maxTags} of ${reportData.config.tags.length} tags. Full statistics are in the Statistics Summary section.`, M, doc.y, { width: contentW(doc) });
    }
    doc.moveDown(0.8);
  }

  /**
   * Add charts section
   */
  private addChartsSection(
    doc: PDFKit.PDFDocument,
    charts: Record<string, Buffer>,
    printHeader: boolean = true,
    descriptions: Record<string, string | undefined> = {}
  ): void {
    if (printHeader) {
      doc.fontSize(16)
        .fillColor('#111827')
        .font('Helvetica-Bold')
        .text('Data Visualizations', { align: 'center' });
      doc.moveDown(1.5);
    }

    let chartCount = 0;

    reportLogger.info('Adding charts section to PDF', {
      totalCharts: Object.keys(charts).length
    });

    for (const [chartName, chartBuffer] of Object.entries(charts)) {
      // Logic for 2 charts per page
      if (chartCount > 0 && chartCount % 2 === 0) {
        doc.addPage();
        reportLogger.debug('Added new page for charts', { chartCount });
      }

      const chartWidth = 545;
      const chartHeight = 280;

      // Print Title
      doc.fontSize(14)
        .fillColor('#111827')
        .font('Helvetica-Bold')
        .text(chartName, { align: 'center' });

      // Print Description if available
      const description = descriptions[chartName];
      if (description) {
        doc.moveDown(0.3);
        doc.fontSize(10)
          .fillColor('#4b5563')
          .font('Helvetica')
          .text(description, { align: 'center', width: chartWidth });
      }

      doc.moveDown(0.7);

      // Validate buffer before embedding
      const validation = chartBufferValidator.validateBuffer(chartBuffer, chartName);

      if (!validation.valid) {
        reportLogger.error('Chart buffer validation failed before embedding', {
          chartName,
          errors: validation.errors
        });

        doc.fontSize(12)
          .font('Helvetica')
          .fillColor('#ef4444')
          .text(`Chart could not be displayed: ${validation.errors[0]}`, {
            align: 'center',
            width: chartWidth
          })
          .fillColor('#111827');
      } else {
        try {
          const bufferInfo = chartBufferValidator.getBufferInfo(chartBuffer);

          if (bufferInfo.format === 'SVG') {
            const rawSvg = chartBuffer.toString('utf8');
            // Remove fixed width/height so it stretches to fill the container width
            const svgString = rawSvg.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, '');

            // @ts-ignore - svg-to-pdfkit type definitions might be missing or incomplete
            const SVGtoPDF = require('svg-to-pdfkit');

            reportLogger.debug('Embedding SVG chart', {
              chartName,
              svgLength: svgString.length,
              x: doc.x,
              y: doc.y
            });

            SVGtoPDF(doc, svgString, doc.x, doc.y, {
              width: chartWidth,
              height: chartHeight,
              preserveAspectRatio: 'none'
            });

            doc.y += chartHeight + 20;
          } else {
            doc.image(chartBuffer, doc.x, doc.y, {
              fit: [chartWidth, chartHeight],
              align: 'center'
            });
            doc.y += chartHeight + 20;
          }
        } catch (error) {
          reportLogger.error('Failed to embed chart image', { chartName, error });
        }
      }

      chartCount++;
    }
  }

  /**
   * Add statistical summary section (Section II of the report)
   * Renders a professional banded table with all key metrics per tag.
   * Columns: Tag | Mean | Median | Std Dev | Min | Max | Count | Quality %
   */
  private addStatisticalSummary(
    doc: PDFKit.PDFDocument,
    statistics: Record<string, StatisticsResult>
  ): void {
    const primaryColor = brandingService.getSettings().primaryColor;

    if (Object.keys(statistics).length === 0) {
      doc.fontSize(11)
        .fillColor(MUTED)
        .font('Helvetica')
        .text('No statistical data available for the selected tags.', M, doc.y);
      return;
    }

    // Section title is drawn by addSectionHeader; only the explanatory line here.
    doc.fontSize(10)
      .fillColor(MUTED)
      .font('Helvetica')
      .text(
        'Key statistical metrics computed from the queried time-series data for each monitoring tag.',
        M, doc.y,
        { width: contentW(doc), align: 'left' }
      );

    doc.moveDown(1);

    // ── Table layout ────────────────────────────────────────────────────────
    const pageWidth = contentW(doc);
    const tableLeft = M;

    // Column definitions  [label, relativeWidth]
    const columns: Array<{ label: string; width: number; align: 'left' | 'center' | 'right' }> = [
      { label: 'Tag', width: pageWidth * 0.20, align: 'left' },
      { label: 'Mean', width: pageWidth * 0.11, align: 'center' },
      { label: 'Median', width: pageWidth * 0.11, align: 'center' },
      { label: 'Std Dev', width: pageWidth * 0.11, align: 'center' },
      { label: 'Min', width: pageWidth * 0.11, align: 'center' },
      { label: 'Max', width: pageWidth * 0.11, align: 'center' },
      { label: 'Count', width: pageWidth * 0.10, align: 'center' },
      { label: 'Quality', width: pageWidth * 0.15, align: 'center' },
    ];

    const totalTableWidth = columns.reduce((s, c) => s + c.width, 0);
    const headerHeight = 26;
    const rowHeight = 22;

    // ── Helper: check page break ─────────────────────────────────────────
    const ensureSpace = (needed: number): void => {
      if (doc.y + needed > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
      }
    };

    // ── Draw header row ──────────────────────────────────────────────────
    ensureSpace(headerHeight + rowHeight);

    const headerTop = doc.y;

    // Header background — branded (was hardcoded navy)
    doc.rect(tableLeft, headerTop, totalTableWidth, headerHeight)
      .fill(primaryColor);

    // Header text
    let xPos = tableLeft;
    doc.fontSize(8.5)
      .fillColor('#ffffff')
      .font('Helvetica-Bold');

    columns.forEach(col => {
      doc.text(col.label, xPos + 4, headerTop + 7, {
        width: col.width - 8,
        align: col.align
      });
      xPos += col.width;
    });

    let currentY = headerTop + headerHeight;

    // ── Draw data rows ───────────────────────────────────────────────────
    const entries = Object.entries(statistics);

    entries.forEach(([tagName, stats], rowIndex) => {
      ensureSpace(rowHeight);
      currentY = doc.y;

      // Alternating row background
      if (rowIndex % 2 === 0) {
        doc.rect(tableLeft, currentY, totalTableWidth, rowHeight)
          .fill(PANEL);
      } else {
        doc.rect(tableLeft, currentY, totalTableWidth, rowHeight)
          .fill('#ffffff');
      }

      // Cell values
      const qualityPct = stats.dataQuality;
      const cells: string[] = [
        tagName.length > 24 ? tagName.substring(0, 22) + '…' : tagName,
        typeof stats.average === 'number' ? stats.average.toFixed(3) : 'N/A',
        typeof stats.median === 'number' ? stats.median.toFixed(3) : 'N/A',
        typeof stats.standardDeviation === 'number' ? stats.standardDeviation.toFixed(3) : 'N/A',
        typeof stats.min === 'number' ? stats.min.toFixed(3) : 'N/A',
        typeof stats.max === 'number' ? stats.max.toFixed(3) : 'N/A',
        typeof stats.count === 'number' ? stats.count.toLocaleString() : 'N/A',
        // Quality rendered separately below
        ''
      ];

      xPos = tableLeft;

      cells.forEach((cell, colIndex) => {
        const col = columns[colIndex]!;
        if (colIndex === 0) {
          // Tag name cell
          doc.font('Helvetica').fontSize(8).fillColor(INK)
            .text(cell, xPos + 4, currentY + 7, { width: col.width - 8, align: col.align });
        } else if (colIndex < columns.length - 1) {
          // Numeric cell — mono so digit columns align
          doc.font('Courier').fontSize(8).fillColor(INK)
            .text(cell, xPos + 4, currentY + 7, { width: col.width - 8, align: col.align });
        } else {
          // ── Quality column: progress bar with percentage beside it ─────
          const barAreaX = xPos + 4;
          const barAreaW = col.width - 8;
          const barW = barAreaW * 0.55;
          const barH = 6;
          const barY = currentY + rowHeight / 2 - barH / 2;

          // Background track
          doc.roundedRect(barAreaX, barY, barW, barH, 2).fill(RULE);

          // Filled portion
          const fillW = Math.max(0, Math.min(barW, barW * (qualityPct / 100)));
          const fillColor = qualityPct >= 90 ? '#16a34a'
            : qualityPct >= 70 ? '#ca8a04'
              : '#dc2626';
          if (fillW > 0) {
            doc.roundedRect(barAreaX, barY, fillW, barH, 2).fill(fillColor);
          }

          // Percentage text to the right of the bar, never over it
          doc.fillColor(BODY).font('Courier').fontSize(7.5)
            .text(`${qualityPct.toFixed(1)}%`, barAreaX + barW + 5, currentY + 8, {
              width: barAreaW - barW - 5,
              align: 'left'
            });
        }
        xPos += col.width;
      });

      // Bottom separator line
      doc.strokeColor('#e5e7eb')
        .lineWidth(0.4)
        .moveTo(tableLeft, currentY + rowHeight)
        .lineTo(tableLeft + totalTableWidth, currentY + rowHeight)
        .stroke();

      doc.y = currentY + rowHeight;
    });

    // ── Table bottom border ──────────────────────────────────────────────
    doc.strokeColor(primaryColor)
      .lineWidth(1)
      .moveTo(tableLeft, doc.y)
      .lineTo(tableLeft + totalTableWidth, doc.y)
      .stroke();

    doc.moveDown(1);

    // ── Legend note ─────────────────────────────────────────────────────
    doc.fontSize(8)
      .fillColor(MUTED)
      .font('Helvetica')
      .text(
        '* Quality %: proportion of data points with Good quality status (codes 0, 16, 133). ' +
        'Std Dev = population standard deviation. Count = number of valid numeric data points.',
        M, doc.y,
        { width: contentW(doc) }
      );

    doc.moveDown(0.5);
    doc.fillColor(INK);
    doc.x = M;
  }

  /**
   * Add a single MiniChart block to the PDF.
   * Replicates the exact layout of the MiniChart component from the frontend.
   */
  /**
   * Format a value for display with dynamic precision based on magnitude.
   * Replicates client-side logic in chartUtils.ts.
   */
  private formatValue(value: number | undefined | null, decimals?: number): string {
    if (value === null || value === undefined || isNaN(value)) return 'N/A';

    let d = decimals;
    if (d === undefined) {
      const absVal = Math.abs(value);
      if (absVal >= 100) {
        d = 0;
      } else if (absVal >= 1) {
        d = 1;
      } else {
        // Match frontend: User requested 0 decimals for values between 0 and 1
        d = 0;
      }
    }

    const formatted = value.toFixed(d);
    return formatted;
  }

  private addMiniChart(
    doc: PDFKit.PDFDocument,
    tagName: string,
    chartBuffer: Buffer,
    description?: string,
    stats?: StatisticsResult,
    trend?: TrendResult
  ): void {
    const { primaryColor, accentColor } = brandingService.getSettings();
    const cardWidth = contentW(doc);
    const cardPadding = 12;
    const headerHeight = 35;
    const chartHeight = 230; // Increased from 220 to provide better ratio when stretched
    const footerHeight = trend ? 48 : 0;
    const totalHeight = headerHeight + chartHeight + footerHeight + (cardPadding * 2);

    const startX = M;
    const currentY = doc.y;

    // Draw Card Border
    doc.roundedRect(startX, currentY, cardWidth, totalHeight, 6)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();

    // 1. Header Area
    const contentX = startX + cardPadding;
    const contentY = currentY + cardPadding;

    doc.fontSize(10).fillColor('#1f2937').font('Helvetica-Bold').text(tagName, contentX, contentY, { width: cardWidth - 250 });
    if (description) {
      doc.fontSize(7.5).fillColor('#9ca3af').font('Helvetica').text(description, contentX, doc.y + 1, { width: cardWidth - 250, lineBreak: false });
    }

    if (stats) {
      const statsX = startX + cardWidth - cardPadding;
      const statsY = contentY;

      doc.fontSize(9);
      const ptsStr = `${stats.count} pts`;
      const ptsWidth = doc.widthOfString(ptsStr);

      const avgLabel = 'AVG: ';
      const avgVal = this.formatValue(stats.average);
      const maxLabel = '  MAX: ';
      const maxVal = this.formatValue(stats.max);

      // Accurate width calculation accounting for font weight changes
      doc.font('Helvetica');
      const avgLabelWidth = doc.widthOfString(avgLabel);
      const maxLabelWidth = doc.widthOfString(maxLabel);
      doc.font('Helvetica-Bold');
      const avgValWidth = doc.widthOfString(avgVal);
      const maxValWidth = doc.widthOfString(maxVal);

      const avgWidth = avgLabelWidth + avgValWidth;
      const maxWidth = maxLabelWidth + maxValWidth;

      // Line 1: Statistics (AVG in the brand's primary color, MAX in its accent color)
      const lineX = statsX - (avgWidth + maxWidth);
      doc.fillColor('#94a3b8').font('Helvetica').text(avgLabel, lineX, statsY, { continued: true })
        .fillColor(primaryColor).font('Helvetica-Bold').text(avgVal, { continued: true })
        .fillColor('#94a3b8').font('Helvetica').text(maxLabel, { continued: true })
        .fillColor(accentColor).font('Helvetica-Bold').text(maxVal);

      // Line 2: Point count
      doc.fontSize(8.5).fillColor('#94a3b8').font('Helvetica').text(ptsStr, statsX - ptsWidth - 5, statsY + 11);
    }

    // 2. Chart
    const chartY = currentY + cardPadding + headerHeight;
    try {
      const bufferInfo = chartBufferValidator.getBufferInfo(chartBuffer);
      if (bufferInfo.format === 'SVG') {
        const rawSvg = chartBuffer.toString('utf8');
        // Remove fixed width/height so it stretches to fill the container width
        const svgString = rawSvg.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, '');

        const SVGtoPDF = require('svg-to-pdfkit');
        SVGtoPDF(doc, svgString, contentX, chartY, {
          width: cardWidth - (cardPadding * 2),
          height: chartHeight,
          preserveAspectRatio: 'xMidYMid meet'
        });
      } else {
        doc.image(chartBuffer, contentX, chartY, {
          fit: [cardWidth - (cardPadding * 2), chartHeight],
          align: 'center',
          valign: 'center'
        });
      }
    } catch (error) {
      reportLogger.error('Failed to embed mini chart', { tagName, error });
    }

    // 3. Regression
    if (trend) {
      const footerPadding = 8;
      const rowHeight = 12;
      const tableY = chartY + chartHeight + 10;
      const tableWidth = cardWidth - (cardPadding * 2);

      // Background for regression info
      doc.roundedRect(contentX, tableY, tableWidth, footerHeight - 10, 3).fill('#f9fafb');
      doc.roundedRect(contentX, tableY, tableWidth, footerHeight - 10, 3).lineWidth(0.3).strokeColor('#f3f4f6').stroke();

      doc.fontSize(8).font('Helvetica');

      // Calculate Rate of Change per minute to match frontend parity
      const slopePerMin = trend.slope * 60000;
      // Use 'Delta' instead of 'Δ' to avoid encoding issues (renders as 9C in some PDF readers)
      const rateStr = `Delta: ${slopePerMin >= 0 ? '+' : ''}${slopePerMin.toFixed(4)} /min`;

      const col1X = contentX + 10;
      const col2X = contentX + (tableWidth * 0.5);

      // Row 1: Equation and R² (brand primary/accent, matching the stat-card accents above)
      doc.fillColor('#94a3b8').text('Equation:', col1X, tableY + footerPadding, { continued: true })
        .fillColor(primaryColor).font('Helvetica-Bold').text(' ' + rateStr);

      doc.fillColor('#94a3b8').font('Helvetica').text('R²:', col2X, tableY + footerPadding, { continued: true })
        .fillColor(accentColor).font('Helvetica-Bold').text(' ' + trend.confidence.toFixed(4));

      // Row 2: Std Dev and Variance
      doc.fillColor('#94a3b8').font('Helvetica').text('Std Dev:', col1X, tableY + footerPadding + rowHeight, { continued: true })
        .fillColor('#374151').font('Helvetica-Bold').text(' ' + this.formatValue(stats?.standardDeviation, 3));

      doc.fillColor('#94a3b8').font('Helvetica').text('Variance:', col2X, tableY + footerPadding + rowHeight, { continued: true })
        .fillColor('#374151').font('Helvetica-Bold').text(' ' + (stats?.standardDeviation ? this.formatValue(Math.pow(stats.standardDeviation, 2), 3) : 'N/A'));
    }

    doc.y = currentY + totalHeight + 15;
  }

  /**
   * Add SPC chart as a professional card with metrics
   */
  private addSPCChart(
    doc: PDFKit.PDFDocument,
    tagName: string,
    chartBuffer: Buffer,
    metrics?: any,
    specLimits?: SpecificationLimits
  ): void {
    const cardWidth = contentW(doc);
    const cardPadding = 12;
    const headerHeight = 35;
    const chartHeight = 230; // Unified with addMiniChart height (2.26 aspect ratio)
    const footerHeight = (metrics || specLimits) ? 50 : 0;
    const totalHeight = headerHeight + chartHeight + footerHeight + (cardPadding * 2);

    const startX = M;

    // Check if we need a new page before drawing this card (safety check)
    if (doc.y > doc.page.height - totalHeight - 50) {
      doc.addPage();
    }

    const drawY = doc.y;

    // Draw Card Border
    doc.roundedRect(startX, drawY, cardWidth, totalHeight, 6)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();

    // 1. Header Area
    const contentX = startX + cardPadding;
    const contentY = drawY + cardPadding;

    doc.fontSize(10).fillColor('#1f2937').font('Helvetica-Bold').text(`${tagName} - SPC Analysis`, contentX, contentY, { width: cardWidth - 50 });

    // 2. Chart
    const chartY = drawY + cardPadding + headerHeight;
    try {
      const bufferInfo = chartBufferValidator.getBufferInfo(chartBuffer);
      if (bufferInfo.format === 'SVG') {
        const rawSvg = chartBuffer.toString('utf8');
        const svgString = rawSvg.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, '');
        // @ts-ignore
        const SVGtoPDF = require('svg-to-pdfkit');
        SVGtoPDF(doc, svgString, contentX, chartY, {
          width: cardWidth - (cardPadding * 2),
          height: chartHeight,
          preserveAspectRatio: 'xMidYMid meet'
        });
      } else {
        doc.image(chartBuffer, contentX, chartY, {
          fit: [cardWidth - (cardPadding * 2), chartHeight],
          align: 'center',
          valign: 'center'
        });
      }
    } catch (error) {
      reportLogger.error('Failed to embed SPC chart', { tagName, error });
    }

    // 3. SPC Metrics Footer
    if (metrics || specLimits) {
      const footerPadding = 8;
      const tableY = chartY + chartHeight + 10;
      const tableWidth = cardWidth - (cardPadding * 2);

      // Background for SPC info
      doc.roundedRect(contentX, tableY, tableWidth, footerHeight - 10, 3).fill('#f8fafc');
      doc.roundedRect(contentX, tableY, tableWidth, footerHeight - 10, 3).lineWidth(0.3).strokeColor('#e2e8f0').stroke();

      doc.fontSize(8.5).font('Helvetica').fillColor('#64748b');

      const col1X = contentX + 15;
      const col2X = contentX + (tableWidth * 0.33);
      const col3X = contentX + (tableWidth * 0.66);

      // Row 1: Mean, UCL, LCL
      if (metrics) {
        doc.text('Mean:', col1X, tableY + footerPadding, { continued: true })
          .fillColor('#0f172a').font('Helvetica-Bold').text(' ' + this.formatValue(metrics.mean));

        doc.fillColor('#64748b').font('Helvetica').text('UCL:', col2X, tableY + footerPadding, { continued: true })
          .fillColor('#ef4444').font('Helvetica-Bold').text(' ' + this.formatValue(metrics.ucl));

        doc.fillColor('#64748b').font('Helvetica').text('LCL:', col3X, tableY + footerPadding, { continued: true })
          .fillColor('#ef4444').font('Helvetica-Bold').text(' ' + this.formatValue(metrics.lcl));
      }

      // Row 2: Cp, Cpk, and Spec Limits
      const row2Y = tableY + footerPadding + 18;
      if (metrics) {
        const cpColor = metrics.cp >= 1.33 ? '#16a34a' : (metrics.cp >= 1.0 ? '#d97706' : '#dc2626');
        const cpkColor = metrics.cpk >= 1.33 ? '#16a34a' : (metrics.cpk >= 1.0 ? '#d97706' : '#dc2626');

        doc.fillColor('#64748b').font('Helvetica').text('Cp:', col1X, row2Y, { continued: true })
          .fillColor(cpColor).font('Helvetica-Bold').text(' ' + (metrics.cp?.toFixed(3) || 'N/A'));

        doc.fillColor('#64748b').font('Helvetica').text('Cpk:', col2X, row2Y, { continued: true })
          .fillColor(cpkColor).font('Helvetica-Bold').text(' ' + (metrics.cpk?.toFixed(3) || 'N/A'));
      }

      if (specLimits) {
        doc.fillColor('#64748b').font('Helvetica').text('Specs:', col3X, row2Y, { continued: true })
          .fillColor('#334155').font('Helvetica-Bold').text(` [${specLimits.lsl ?? '-∞'}, ${specLimits.usl ?? '∞'}]`);
      }
    }

    doc.y = drawY + totalHeight + 15;
  }

  /**
   * Add data table section showing all data points
   */
  private addDataTable(doc: PDFKit.PDFDocument, tagName: string, data: TimeSeriesData[]): void {
    doc.fontSize(13)
      .fillColor(INK)
      .font('Helvetica-Bold')
      .text(`Data Table: ${tagName}`, M);

    doc.moveDown(0.5);

    // Table configuration
    const tableTop = doc.y;
    const tableLeft = M;
    const pageWidth = contentW(doc);

    // Column widths (proportional)
    const colWidths = {
      timestamp: pageWidth * 0.35,
      value: pageWidth * 0.25,
      quality: pageWidth * 0.20,
      status: pageWidth * 0.20
    };

    const rowHeight = 20;
    const headerHeight = 25;

    // Helper function to get quality status text
    const getQualityStatus = (quality: number): string => {
      if (quality === 0) return 'Good';
      if (quality === 12) return 'Uncertain';
      if (quality === 1) return 'Bad';
      return `Code ${quality}`;
    };

    // Helper function to check if we need a new page
    const checkPageBreak = (currentY: number) => {
      if (currentY > doc.page.height - 100) {
        doc.addPage();
        return doc.page.margins.top; // Reset to top margin
      }
      return currentY;
    };

    // Draw table header
    let currentY = tableTop;

    doc.fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#374151');

    // Header background
    doc.rect(tableLeft, currentY, pageWidth, headerHeight)
      .fill('#f3f4f6');

    // Header text
    doc.fillColor('#374151')
      .text('Timestamp', tableLeft + 5, currentY + 7, { width: colWidths.timestamp, align: 'left' })
      .text('Value', tableLeft + colWidths.timestamp + 5, currentY + 7, { width: colWidths.value, align: 'right' })
      .text('Quality Code', tableLeft + colWidths.timestamp + colWidths.value + 5, currentY + 7, { width: colWidths.quality, align: 'center' })
      .text('Status', tableLeft + colWidths.timestamp + colWidths.value + colWidths.quality + 5, currentY + 7, { width: colWidths.status, align: 'center' });

    currentY += headerHeight;

    // Draw table rows
    doc.font('Helvetica')
      .fontSize(9);

    // Limit to first 1000 rows to avoid huge PDFs
    const maxRows = Math.min(data.length, 1000);

    for (let i = 0; i < maxRows; i++) {
      const row = data[i];

      // Safety check
      if (!row) continue;

      // Check if we need a new page
      currentY = checkPageBreak(currentY);

      // Alternate row colors
      if (i % 2 === 0) {
        doc.rect(tableLeft, currentY, pageWidth, rowHeight)
          .fill('#f9fafb');
      }

      // Format timestamp
      const timestamp = row.timestamp instanceof Date
        ? row.timestamp.toLocaleString()
        : new Date(row.timestamp).toLocaleString();

      // Format value
      const value = typeof row.value === 'number'
        ? row.value.toFixed(2)
        : String(row.value);

      // Get quality status
      const qualityStatus = getQualityStatus(row.quality);

      // Use grayscale for all text (no colored quality indicators in tables);
      // timestamps and numerics in mono so the columns read as a log.
      doc.fillColor(INK).font('Courier')
        .text(timestamp, tableLeft + 5, currentY + 5, { width: colWidths.timestamp, align: 'left' })
        .text(value, tableLeft + colWidths.timestamp + 5, currentY + 5, { width: colWidths.value, align: 'right' })
        .text(String(row.quality), tableLeft + colWidths.timestamp + colWidths.value + 5, currentY + 5, { width: colWidths.quality, align: 'center' })
        .font('Helvetica')
        .text(qualityStatus, tableLeft + colWidths.timestamp + colWidths.value + colWidths.quality + 5, currentY + 5, { width: colWidths.status, align: 'center' });

      currentY += rowHeight;
    }

    // Add note if data was truncated
    if (data.length > maxRows) {
      currentY = checkPageBreak(currentY + 10);
      doc.fillColor('#6b7280')
        .fontSize(10)
        .text(`Note: Showing first ${maxRows} of ${data.length} data points. Export to CSV for complete data.`,
          tableLeft, currentY + 10, { align: 'center', width: pageWidth });
    }

    // Reset color
    doc.fillColor('black');
    doc.y = currentY + 30;
  }

  /**
   * Add report footer to all pages with generation info and page numbers
   */
  private addReportFooter(doc: PDFKit.PDFDocument, reportData: ReportData): void {
    try {
      // Get total page count
      const range = doc.bufferedPageRange();
      const totalPages = range.count;

      // Format generation timestamp
      const generatedDate = reportData.generatedAt instanceof Date
        ? reportData.generatedAt.toLocaleString()
        : 'Unknown';

      // Format report period for header
      const startTimeStr = reportData.config.timeRange.startTime instanceof Date
        ? reportData.config.timeRange.startTime.toLocaleString()
        : 'Unknown';
      const endTimeStr = reportData.config.timeRange.endTime instanceof Date
        ? reportData.config.timeRange.endTime.toLocaleString()
        : 'Unknown';
      const periodStr = `Report Period: ${startTimeStr} - ${endTimeStr}`;

      // Iterate through all pages and add decorations (header/footer) to each
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);

        // Add header to all pages BUT the first
        if (i > 0) {
          doc.fillColor(MUTED)
            .fontSize(8)
            .font('Helvetica')
            .text(
              `${reportData.config.name} — ${periodStr}`,
              M,
              25,
              { align: 'right', width: doc.page.width - M * 2 }
            );

          // Add a subtle line below the repeat header
          doc.strokeColor(RULE)
            .lineWidth(0.5)
            .moveTo(M, 38)
            .lineTo(doc.page.width - M, 38)
            .stroke();
        }

        // Temporarily disable bottom margin to prevent auto-page-adding
        // when writing in the footer area (within the original margin)
        const oldBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        const pageNumber = i + 1;
        const footerY = doc.page.height - 55;

        // Add horizontal separator line above footer
        doc.strokeColor(RULE)
          .lineWidth(0.5)
          .moveTo(M, footerY)
          .lineTo(doc.page.width - M, footerY)
          .stroke();

        // Add generation timestamp (left side)
        doc.fillColor(MUTED)
          .fontSize(7.5)
          .font('Helvetica')
          .text(
            `Generated by ${brandingService.getDisplayName()} v${packageJson.version} on ${generatedDate}`,
            M,
            footerY + 10,
            { align: 'left', width: doc.page.width - 220 }
          );

        // Custom report footer text (centre)
        const footerText = brandingService.getSettings().reportFooter;
        if (footerText) {
          doc.text(footerText, M, footerY + 10, { align: 'center', width: doc.page.width - M * 2 });
        }

        // Add page numbers (right side)
        doc.font('Courier').text(
          `${pageNumber} / ${totalPages}`,
          doc.page.width - M - 100,
          footerY + 10,
          { align: 'right', width: 100 }
        );

        // Restore bottom margin
        doc.page.margins.bottom = oldBottomMargin;
      }

      // Reset color
      doc.fillColor('#111827');
    } catch (error) {
      reportLogger.error('Error adding footer to pages', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Add SPC metrics summary table
   */
  addSPCMetricsTable(doc: PDFKit.PDFDocument, metrics: SPCMetricsSummary[]): void {
    if (!metrics || metrics.length === 0) {
      return;
    }

    doc.fontSize(13)
      .fillColor(INK)
      .font('Helvetica-Bold')
      .text('SPC Metrics Summary', M); // Explicit x position

    doc.moveDown(0.5);

    const tableTop = doc.y + 10;
    const tableLeft = M;
    // Proportional widths summing to the content width (tag column widest)
    const w = contentW(doc);
    const colWidths: number[] = [0.19, 0.094, 0.094, 0.094, 0.094, 0.085, 0.085, 0.085, 0.085, 0.094].map(f => f * w);
    const headers = ['Tag Name', 'Mean', 'StdDev', 'LCL', 'UCL', 'LSL', 'USL', 'Cp', 'Cpk', 'Stat'];
    const rowHeight = 20;
    const headerHeight = 25;

    // Helper function to check if we need a new page
    const checkPageBreak = (currentY: number) => {
      if (currentY > doc.page.height - 100) {
        doc.addPage();
        return doc.page.margins.top; // Reset to top margin
      }
      return currentY;
    };

    let currentY = tableTop;

    // Draw table header background
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    doc.rect(tableLeft, currentY, tableWidth, headerHeight)
      .fill('#f3f4f6');

    // Draw table header text
    let x = tableLeft;
    doc.fontSize(8) // Reduced from 10 to fit more columns
      .fillColor('#374151')
      .font('Helvetica-Bold');

    headers.forEach((header, i) => {
      const width = colWidths[i] || 60;
      doc.text(header, x + 2, currentY + 7, { // Reduced padding
        width: width - 4,
        align: 'center'
      });
      x += width;
    });

    currentY += headerHeight;

    // Draw table rows
    doc.fontSize(8) // Reduced from 9 to fit
      .fillColor('#111827')
      .font('Helvetica');

    metrics.forEach((metric, index) => {
      // Check if we need a new page
      currentY = checkPageBreak(currentY);

      // Alternate row colors
      if (index % 2 === 0) {
        doc.rect(tableLeft, currentY, tableWidth, rowHeight)
          .fill('#f9fafb');
      }

      x = tableLeft;

      // Tag name (left-aligned)
      doc.fillColor(INK).font('Helvetica')
        .text(metric.tagName, x + 2, currentY + 5, {
          width: colWidths[0]! - 4,
          align: 'left'
        });
      x += colWidths[0]!;

      // Numeric cells in mono so digit columns align
      doc.font('Courier');

      // Mean (X̄)
      doc.text(metric.mean.toFixed(2), x + 2, currentY + 5, {
        width: colWidths[1]! - 4,
        align: 'center'
      });
      x += colWidths[1]!;

      // StdDev (σest)
      doc.text(metric.stdDev.toFixed(2), x + 2, currentY + 5, {
        width: colWidths[2]! - 4,
        align: 'center'
      });
      x += colWidths[2]!;

      // LCL
      doc.text(metric.lcl.toFixed(2), x + 2, currentY + 5, {
        width: colWidths[3]! - 4,
        align: 'center'
      });
      x += colWidths[3]!;

      // UCL
      doc.text(metric.ucl.toFixed(2), x + 2, currentY + 5, {
        width: colWidths[4]! - 4,
        align: 'center'
      });
      x += colWidths[4]!;

      // LSL
      doc.text(
        metric.lsl !== null ? metric.lsl.toFixed(2) : 'N/A',
        x + 2,
        currentY + 5,
        { width: colWidths[5]! - 4, align: 'center' }
      );
      x += colWidths[5]!;

      // USL
      doc.text(
        metric.usl !== null ? metric.usl.toFixed(2) : 'N/A',
        x + 2,
        currentY + 5,
        { width: colWidths[6]! - 4, align: 'center' }
      );
      x += colWidths[6]!;

      // Cp
      doc.text(
        metric.cp !== null ? metric.cp.toFixed(2) : 'N/A',
        x + 2,
        currentY + 5,
        { width: colWidths[7]! - 4, align: 'center' }
      );
      x += colWidths[7]!;

      // Cpk
      doc.text(
        metric.cpk !== null ? metric.cpk.toFixed(2) : 'N/A',
        x + 2,
        currentY + 5,
        { width: colWidths[8]! - 4, align: 'center' }
      );
      x += colWidths[8]!;

      // Capability assessment with visual indicator
      const capabilityText = metric.capability;
      let capabilityColor = '#111827'; // Default black

      if (metric.capability === 'Capable') {
        capabilityColor = '#111827'; // Dark
      } else if (metric.capability === 'Marginal') {
        capabilityColor = '#6b7280'; // Gray
      } else if (metric.capability === 'Not Capable') {
        capabilityColor = '#9ca3af'; // Light gray
      }

      doc.fillColor(capabilityColor).font('Helvetica')
        .text(capabilityText, x + 2, currentY + 5, {
          width: colWidths[9]! - 4,
          align: 'center'
        });

      currentY += rowHeight;
    });

    // Reset color and position
    doc.fillColor('#111827');
    doc.y = currentY + 20;
  }

  /**
   * Calculate data quality breakdown
   */
  private calculateQualityBreakdown(data: TimeSeriesData[]) {
    const good = data.filter(d => d.quality === 0).length;
    const bad = data.filter(d => d.quality !== 0 && d.quality !== 12).length;
    const uncertain = data.filter(d => d.quality === 12).length;
    const total = data.length;

    return {
      good,
      bad,
      uncertain,
      goodPercent: (good / total) * 100,
      badPercent: (bad / total) * 100,
      uncertainPercent: (uncertain / total) * 100
    };
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.templatesDir)) {
      fs.mkdirSync(this.templatesDir, { recursive: true });
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Register Handlebars helpers
   */
  private registerHandlebarsHelpers(): void {
    // Date formatting helper
    Handlebars.registerHelper('formatDate', (date: any) => {
      if (date instanceof Date) {
        return date.toLocaleString();
      }
      return 'Invalid Date';
    });

    // Number formatting helper
    Handlebars.registerHelper('formatNumber', (num: any, decimals: number = 2) => {
      if (typeof num === 'number' && !isNaN(num)) {
        return num.toFixed(decimals);
      }
      return '0.00';
    });

    // Percentage helper
    Handlebars.registerHelper('percentage', (num: any) => {
      if (typeof num === 'number' && !isNaN(num)) {
        return (num * 100).toFixed(1) + '%';
      }
      return '0.0%';
    });

    // Conditional helper
    Handlebars.registerHelper('ifEquals', function (this: any, arg1: any, arg2: any, options: any) {
      return (arg1 == arg2) ? options.fn(this) : options.inverse(this);
    });
  }

  /**
   * Load and compile template
   */
  async loadTemplate(templateName: string): Promise<HandlebarsTemplateDelegate> {
    const templatePath = path.join(this.templatesDir, `${templateName}.hbs`);

    if (!fs.existsSync(templatePath)) {
      // Create default template if it doesn't exist
      await this.createDefaultTemplate(templateName);
    }

    const templateContent = fs.readFileSync(templatePath, 'utf8');
    return Handlebars.compile(templateContent);
  }

  /**
   * Create default template
   */
  private async createDefaultTemplate(templateName: string): Promise<void> {
    const defaultTemplate = `
<!DOCTYPE html>
<html>
<head>
    <title>{{reportName}}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background-color: #0ea5e9; color: white; padding: 20px; text-align: center; }
        .content { margin: 20px 0; }
        .tag-section { margin: 30px 0; border-bottom: 1px solid #eee; padding-bottom: 20px; }
        .statistics { display: flex; justify-content: space-between; margin: 20px 0; }
        .stat-item { text-align: center; }
    </style>
</head>
<body>
    <div class="header">
        <h1>{{reportName}}</h1>
        <p>{{description}}</p>
    </div>
    
    <div class="content">
        <p><strong>Generated:</strong> {{formatDate generatedAt}}</p>
        <p><strong>Time Range:</strong> {{formatDate timeRange.startTime}} - {{formatDate timeRange.endTime}}</p>
        <p><strong>Tags:</strong> {{#each tags}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}</p>
        
        {{#each tagData}}
        <div class="tag-section">
            <h2>{{@key}}</h2>
            <p>Data Points: {{this.length}}</p>
            {{#if ../statistics.[this]}}
            <div class="statistics">
                <div class="stat-item">
                    <strong>{{formatNumber ../statistics.[this].min}}</strong><br>
                    <small>Minimum</small>
                </div>
                <div class="stat-item">
                    <strong>{{formatNumber ../statistics.[this].max}}</strong><br>
                    <small>Maximum</small>
                </div>
                <div class="stat-item">
                    <strong>{{formatNumber ../statistics.[this].average}}</strong><br>
                    <small>Average</small>
                </div>
                <div class="stat-item">
                    <strong>{{percentage ../statistics.[this].dataQuality}}</strong><br>
                    <small>Data Quality</small>
                </div>
            </div>
            {{/if}}
        </div>
        {{/each}}
    </div>
</body>
</html>
    `;

    const templatePath = path.join(this.templatesDir, `${templateName}.hbs`);
    fs.writeFileSync(templatePath, defaultTemplate.trim());
  }
}

// Export singleton instance
export const reportGenerationService = new ReportGenerationService();