/**
 * Data Retrieval Service for AVEVA Historian
 * Handles time-series data queries, tag information, and data filtering
 */

import { getHistorianConnection } from './historianConnection';
import { dbLogger } from '@/utils/logger';
import { createError } from '@/middleware/errorHandler';
import { CacheService } from './cacheService';
import { progressTracker } from '@/middleware/progressTracker';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { TimeSeriesData, TagInfo, TimeRange, DataFilter, QueryResult, HistorianQueryOptions, RetrievalMode, QualityCode, StatisticsResult, FilterCondition } from '@/types/historian';
import { opcuaManager } from './opcua/opcuaConnectionManager';
import { NO_CONNECTION_MESSAGE } from './opcua/tagResolver';
import { teveConfigService } from './teveConfigService';

function historicalTTL(endTime: Date): number {
  const ageMs = Date.now() - endTime.getTime();
  if (ageMs < 3_600_000)   return 60;      // < 1 h old
  if (ageMs < 86_400_000)  return 300;     // < 24 h
  if (ageMs < 604_800_000) return 3_600;   // < 7 d
  return 86_400;                            // older → 24 h
}

export class DataRetrievalService {
  private cacheService: CacheService | undefined;
  private readonly STREAM_BATCH_SIZE = 1000;
  private readonly LARGE_DATASET_THRESHOLD = 10000;

  constructor(cacheService?: CacheService) {
    this.cacheService = cacheService;
  }

  setCacheService(svc: CacheService): void {
    this.cacheService = svc;
  }

  private getConnection() {
    return getHistorianConnection();
  }

  private generateQueryHash(query: string, params: Record<string, any>): string {
    const queryString = query + JSON.stringify(params);
    return createHash('md5').update(queryString).digest('hex');
  }

  /**
   * Get time-series data for a specific tag within a time range
   */
  async getTimeSeriesData(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions,
    operationId?: string
  ): Promise<TimeSeriesData[]> {
    // 1. Check for OPC UA tags
    if (tagName.startsWith('opcua:')) {
      return this.getOpcuaTimeSeriesData(tagName, timeRange, options);
    }

    // 2. Check for TEVE tags — a separate, optional, admin-configured
    // alternative/parallel historian (see teveConfigService). Not the AVEVA connection.
    if (tagName.startsWith('tensor:')) {
      return this.getTensorTimeSeriesData(tagName, timeRange);
    }

    try {
      dbLogger.info('Retrieving time-series data', { tagName, timeRange, options });

      // Update progress if tracking
      if (operationId) {
        progressTracker.updateProgress(operationId, 'connecting', 5, 'Connecting to database');
      }

      // Validate inputs
      this.validateTimeRange(timeRange);
      this.validateTagName(tagName);

      // Check cache first if caching is enabled
      if (this.cacheService) {
        const cachedData = await this.cacheService.getCachedTimeSeriesData(
          tagName,
          timeRange.startTime,
          timeRange.endTime,
          options
        );

        if (cachedData) {
          dbLogger.debug(`Cache hit for time-series data: ${tagName}`);
          if (operationId) {
            progressTracker.completeOperation(operationId, 'Data retrieved from cache');
          }
          return cachedData;
        }
      }

      /* 
      // Optimized: Skip size estimation to avoid redundant query as requested
      const estimatedSize = await this.estimateDataSize(tagName, timeRange);

      if (estimatedSize > this.LARGE_DATASET_THRESHOLD) {
        dbLogger.info(`Large dataset detected (${estimatedSize} points), using streaming approach`);
        return this.getTimeSeriesDataStreaming(tagName, timeRange, options, operationId);
      }
      */

      if (operationId) {
        progressTracker.updateProgress(operationId, 'querying', 20, 'Executing optimized query');
      }

      // Build optimized query
      const query = this.buildOptimizedTimeSeriesQuery(tagName, timeRange, options);
      const params = this.buildQueryParams(tagName, timeRange, options);

      // Log the query and parameters for debugging
      dbLogger.info('Executing time-series query:', {
        query: query.trim(),
        params: {
          tagName: params.tagName,
          startTime: params.startTime,
          endTime: params.endTime,
          mode: params.mode,
          resolution: params.resolution,
          maxPoints: params.maxPoints
        }
      });

      // Log what the rendered query would look like
      const renderedQuery = query
        .replace('@tagName', `'${params.tagName}'`)
        .replace('@startTime', `'${params.startTime}'`)
        .replace('@endTime', `'${params.endTime}'`);
      dbLogger.info('Rendered SQL query (approximate):', { renderedQuery: renderedQuery.trim() });

      const result = await this.getConnection().executeQuery<any>(query, params);

      // Log raw database results for debugging
      dbLogger.info('Raw database result:', {
        recordCount: result.recordset.length,
        firstRow: result.recordset[0],
        lastRow: result.recordset[result.recordset.length - 1]
      });

      if (operationId) {
        progressTracker.updateProgress(operationId, 'processing', 70, 'Processing query results');
      }

      // Transform raw data to TimeSeriesData format
      const timeSeriesData = result.recordset.map(row => this.transformToTimeSeriesData(row, tagName));

      // Log transformed data for debugging
      dbLogger.info('Transformed data:', {
        count: timeSeriesData.length,
        firstPoint: timeSeriesData[0],
        lastPoint: timeSeriesData[timeSeriesData.length - 1]
      });

      // Cache the result if caching is enabled (tiered TTL based on data age)
      if (this.cacheService && timeSeriesData.length > 0) {
        if (operationId) {
          progressTracker.updateProgress(operationId, 'caching', 90, 'Caching results');
        }
        await this.cacheService.cacheTimeSeriesData(
          tagName,
          timeRange.startTime,
          timeRange.endTime,
          timeSeriesData,
          options,
          historicalTTL(timeRange.endTime)
        );
      }

      if (operationId) {
        progressTracker.completeOperation(operationId, `Retrieved ${timeSeriesData.length} data points`);
      }

      dbLogger.info(`Retrieved ${timeSeriesData.length} data points for tag ${tagName}`);
      return timeSeriesData;

    } catch (error) {
      if (operationId) {
        progressTracker.failOperation(operationId, error instanceof Error ? error.message : 'Unknown error');
      }
      dbLogger.error('Failed to retrieve time-series data:', { tagName, timeRange, error });
      throw error;
    }
  }

  /**
   * Get time-series data using streaming for large datasets
   */
  private async getTimeSeriesDataStreaming(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions,
    operationId?: string
  ): Promise<TimeSeriesData[]> {
    const results: TimeSeriesData[] = [];
    let processedCount = 0;
    let totalEstimated = await this.estimateDataSize(tagName, timeRange);

    // Create streaming query with pagination
    const batchSize = this.STREAM_BATCH_SIZE;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      if (operationId) {
        const progress = Math.min(90, (processedCount / totalEstimated) * 80 + 10);
        progressTracker.updateProgress(
          operationId,
          'querying',
          progress,
          `Processing batch ${Math.floor(offset / batchSize) + 1}, ${processedCount}/${totalEstimated} points`
        );
      }

      const query = this.buildStreamingQuery(tagName, timeRange, options, batchSize, offset);
      const params = this.buildQueryParams(tagName, timeRange, options);
      params.offset = offset;
      params.batchSize = batchSize;

      const result = await this.getConnection().executeQuery<any>(query, params);
      const batch = result.recordset.map(row => this.transformToTimeSeriesData(row, tagName));

      results.push(...batch);
      processedCount += batch.length;
      hasMore = batch.length === batchSize;
      offset += batchSize;

      // Memory management: if results get too large, consider chunked processing
      if (results.length > 50000) {
        dbLogger.warn('Large result set detected, consider using chunked processing', {
          tagName,
          currentSize: results.length
        });
      }
    }

    return results;
  }

  /**
   * Estimate data size for query optimization
   */
  private async estimateDataSize(tagName: string, timeRange: TimeRange): Promise<number> {
    try {
      const query = `
        SELECT COUNT(*) as estimatedCount
        FROM History
        WHERE TagName = @tagName
          AND DateTime >= @startTime
          AND DateTime <= @endTime
      `;

      const params = {
        tagName,
        startTime: this.formatDateForHistorian(timeRange.startTime),
        endTime: this.formatDateForHistorian(timeRange.endTime)
      };

      const result = await this.getConnection().executeQuery<{ estimatedCount: number }>(query + " AND wwTimeZone = 'UTC' AND wwVersion = 'Latest'", params);
      return result.recordset[0]?.estimatedCount || 0;
    } catch (error) {
      dbLogger.warn('Failed to estimate data size, using default', { error });
      return this.LARGE_DATASET_THRESHOLD;
    }
  }

  /**
   * Get basic statistics using SQL standard aggregates (AVG, MIN, MAX)
   * Requirements: Use SQL to perform the calculation at the database level
   */
  public async getStatistics(
    tagName: string,
    timeRange: TimeRange
  ): Promise<StatisticsResult> {
    // TEVE has no SQL aggregate endpoint of its own — fetch the raw
    // points (already routed correctly) and compute stats the same way report
    // generation does for provided-but-uncomputed tags (statisticalAnalysisService).
    if (tagName.startsWith('tensor:')) {
      this.validateTimeRange(timeRange);
      const data = await this.getTensorTimeSeriesData(tagName, timeRange);
      if (data.length === 0) {
        return { average: 0, min: 0, max: 0, median: 0, standardDeviation: 0, count: 0, dataQuality: 0 };
      }
      const { statisticalAnalysisService } = await import('./statisticalAnalysis');
      return statisticalAnalysisService.calculateStatisticsSync(data);
    }

    try {
      this.validateTimeRange(timeRange);
      this.validateTagName(tagName);

      if (this.cacheService) {
        const cached = await this.cacheService.getCachedStatistics(tagName, timeRange.startTime, timeRange.endTime);
        if (cached) {
          dbLogger.debug(`Cache hit for statistics: ${tagName}`);
          return cached;
        }
      }

      dbLogger.info('Retrieving statistics via SQL aggregates', { tagName, timeRange });

      // Use a more standard SQL approach that works with History view
      // Removing explicit wwRetrievalMode='Full' to let it use default or whatever is active
      const query = `
        SELECT 
          AVG(CAST(Value as FLOAT)) as average,
          MIN(CAST(Value as FLOAT)) as min,
          MAX(CAST(Value as FLOAT)) as max,
          STDEV(CAST(Value as FLOAT)) as standardDeviation,
          COUNT(*) as count,
          SUM(CASE WHEN Quality IN (0, 16, 133) THEN 1 ELSE 0 END) as goodCount
        FROM History
        WHERE TagName = @tagName
          AND DateTime >= @startTime
          AND DateTime <= @endTime
          AND wwTimeZone = 'UTC'
          AND wwVersion = 'Latest'
      `;

      const params = {
        tagName,
        startTime: this.formatDateForHistorian(timeRange.startTime),
        endTime: this.formatDateForHistorian(timeRange.endTime)
      };

      const result = await this.getConnection().executeQuery<any>(query, params);
      const row = result.recordset[0];

      dbLogger.debug('SQL statistics raw result', { tagName, row });

      if (!row || row.count === 0 || row.average === null) {
        // If no data found via aggregates, try a fallback or return empty stats
        dbLogger.warn('No statistics found via SQL aggregates', { tagName });
        return {
          average: 0,
          min: 0,
          max: 0,
          median: 0,
          standardDeviation: 0,
          count: 0,
          dataQuality: 0
        };
      }

      const totalCount = parseInt(row.count) || 0;
      const goodCount = parseInt(row.goodCount) || 0;
      const dataQuality = totalCount > 0 ? (goodCount / totalCount) * 100 : 0;

      const stats = {
        average: Number(row.average),
        min: Number(row.min),
        max: Number(row.max),
        median: 0, // SQL aggregates don't support median; compute client-side if needed
        standardDeviation: Number(row.standardDeviation) || 0,
        count: totalCount,
        dataQuality
      };

      if (this.cacheService) {
        await this.cacheService.cacheStatistics(tagName, timeRange.startTime, timeRange.endTime, stats);
      }

      dbLogger.info('SQL statistics calculated successfully', { tagName, stats });
      return stats;

    } catch (error) {
      dbLogger.error('Failed to retrieve SQL statistics:', { tagName, timeRange, error });
      throw error;
    }
  }

  private buildOptimizedTimeSeriesQuery(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions
  ): string {
    const includeQuality = options?.includeQuality !== false;
    const mode = options?.mode || RetrievalMode.Full;

    if (mode === RetrievalMode.Live) {
      return `
        SELECT 
          DateTime as timestamp,
          TagName as tagName,
          Value as value,
          ${includeQuality ? 'Quality as quality' : 'NULL as quality'}
        FROM Live
        WHERE TagName = @tagName
      `;
    }

    const isCyclic = mode === RetrievalMode.Cyclic || mode === RetrievalMode.Average;

    let query = `
      SELECT ${options?.limit ? `TOP ${options.limit}` : ''}
        DateTime as timestamp,
        TagName as tagName,
        Value as value,
        ${includeQuality ? 'Quality as quality' : 'NULL as quality'}
      FROM History
      WHERE TagName = @tagName
        AND DateTime >= @startTime
        AND DateTime <= @endTime
        AND wwRetrievalMode = @mode
        ${isCyclic ? 'AND wwResolution = @resolution' : ''}
        ${options?.qualityFilter && options.qualityFilter.length > 0 ? `AND Quality IN (${options.qualityFilter.map((_, i) => `@quality${i}`).join(', ')})` : ''}
        AND wwTimeZone = 'UTC'
        AND wwVersion = 'Latest'
      ORDER BY ${options?.orderBy || 'DateTime ASC'}
    `;

    return query;
  }

  /**
   * Build streaming query with pagination
   */
  private buildStreamingQuery(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions,
    batchSize: number = 1000,
    offset: number = 0
  ): string {
    const mode = options?.mode || RetrievalMode.Full;
    const includeQuality = options?.includeQuality !== false;

    return `
      SELECT 
        DateTime as timestamp,
        Value as value,
        ${includeQuality ? 'Quality as quality,' : ''}
        TagName as tagName
      FROM History
      WHERE TagName = @tagName
        AND DateTime >= @startTime
        AND DateTime <= @endTime
        AND wwRetrievalMode = @mode
        AND wwTimeZone = 'UTC'
        AND wwVersion = 'Latest'
      ORDER BY ${options?.orderBy || 'DateTime ASC'}
      OFFSET @offset ROWS
      FETCH NEXT @batchSize ROWS ONLY
    `;
  }



  /**
   * Create data processing stream for memory-efficient operations
   */
  createDataProcessingStream(): Transform {
    const self = this;
    return new Transform({
      objectMode: true,
      transform(chunk: any, encoding, callback) {
        try {
          // Process data chunk
          const processed = self.processDataChunk(chunk);
          callback(null, processed);
        } catch (error) {
          callback(error instanceof Error ? error : new Error('Processing error'));
        }
      }
    });
  }

  /**
   * Process data chunk for streaming operations
   */
  private processDataChunk(chunk: any): TimeSeriesData {
    return {
      timestamp: new Date(chunk.timestamp),
      value: parseFloat(chunk.value),
      quality: chunk.quality || QualityCode.Good,
      tagName: chunk.tagName
    };
  }
  async getMultipleTimeSeriesData(
    tagNames: string[],
    timeRange: TimeRange,
    options?: HistorianQueryOptions,
    operationId?: string
  ): Promise<Record<string, TimeSeriesData[]>> {
    try {
      dbLogger.info('Retrieving multiple time-series data', { tagNames, timeRange });

      // Split Historian, OPC UA, and TEVE tags
      const historianTags = tagNames.filter(t => !t.startsWith('opcua:') && !t.startsWith('tensor:'));
      const opcuaTags = tagNames.filter(t => t.startsWith('opcua:'));
      const tensorTags = tagNames.filter(t => t.startsWith('tensor:'));

      const results: Record<string, TimeSeriesData[]> = {};

      // Handle Historian tags if any
      if (historianTags.length > 0) {
        const historianPromises = historianTags.map((tagName, index) =>
          this.getTimeSeriesData(tagName, timeRange, options)
            .then(data => ({ tagName, data }))
            .catch(error => ({ tagName, error }))
        );

        const historianResults = await Promise.all(historianPromises);
        historianResults.forEach(result => {
          if ('error' in result) {
            dbLogger.warn(`Historian tag query failed: ${result.tagName}`, { error: result.error });
          } else {
            results[result.tagName] = result.data;
          }
        });
      }

      // Handle OPC UA tags if any
      if (opcuaTags.length > 0) {
        const opcuaPromises = opcuaTags.map(async (tagName) => {
          try {
            const data = await this.getOpcuaTimeSeriesData(tagName, timeRange, options);
            return { tagName, data };
          } catch (error) {
            dbLogger.warn(`OPC UA tag query failed: ${tagName}`, { error });
            return { tagName, data: [] };
          }
        });

        const opcuaResults = await Promise.all(opcuaPromises);
        opcuaResults.forEach(result => {
          results[result.tagName] = result.data;
        });
      }

      // Handle TEVE tags if any
      if (tensorTags.length > 0) {
        const tensorPromises = tensorTags.map(async (tagName) => {
          try {
            const data = await this.getTensorTimeSeriesData(tagName, timeRange);
            return { tagName, data };
          } catch (error) {
            dbLogger.warn(`TEVE tag query failed: ${tagName}`, { error });
            return { tagName, data: [] };
          }
        });

        const tensorResults = await Promise.all(tensorPromises);
        tensorResults.forEach(result => {
          results[result.tagName] = result.data;
        });
      }

      if (operationId) {
        progressTracker.completeOperation(operationId, `Retrieved data for ${Object.keys(results).length}/${tagNames.length} tags`);
      }

      return results;
    } catch (error) {
      if (operationId) {
        progressTracker.failOperation(operationId, error instanceof Error ? error.message : 'Unknown error');
      }
      dbLogger.error('Failed to retrieve multiple time-series data:', error);
      throw error;
    }
  }

  /**
   * Get available tags with optional filtering
   */
  async getTagList(filter?: string): Promise<TagInfo[]> {
    try {
      dbLogger.info('Retrieving tag list', { filter });

      // Check cache first if caching is enabled
      if (this.cacheService) {
        const cachedTags = filter
          ? await this.cacheService.getCachedFilteredTags(filter)
          : await this.cacheService.getCachedTagList();

        if (cachedTags) {
          dbLogger.debug(`Cache hit for tag list${filter ? ` with filter: ${filter}` : ''}`);
          // TEVE's enabled/configured state can change independently of the
          // AVEVA tag cache TTL, so it's always fetched fresh rather than cached here.
          return [...cachedTags, ...this.filterTensorTags(await this.getTensorTagList(), filter)];
        }
      }

      // Use the standard AVEVA Historian Tag view joined with AnalogTag and EngineeringUnit
      // to get comprehensive metadata including units and ranges.
      let query = `
        SELECT 
          t.TagName as name,
          t.Description as description,
          eu.Unit as units,
          CASE 
            WHEN t.TagType = 1 THEN 'analog'
            WHEN t.TagType = 2 THEN 'discrete'
            WHEN t.TagType = 3 THEN 'string'
            ELSE 'unknown'
          END as dataType,
          t.DateCreated as lastUpdate,
          at.MinEU as minValue,
          at.MaxEU as maxValue
        FROM Tag t
        LEFT JOIN AnalogTag at ON t.TagName = at.TagName
        LEFT JOIN EngineeringUnit eu ON at.EUKey = eu.EUKey
        WHERE 1=1
      `;

      const params: Record<string, any> = {};

      if (filter) {
        dbLogger.debug(`Applying tag filter: ${filter}`);
        // Use UPPER for case-insensitive search regardless of collation
        // and COALESCE to safely handle NULL descriptions
        query += ` AND (UPPER(t.TagName) LIKE UPPER(@filter) OR UPPER(COALESCE(t.Description, '')) LIKE UPPER(@filter))`;
        params.filter = `%${filter}%`;
      }

      query += ` ORDER BY t.TagName`;

      const result = await this.getConnection().executeQuery<any>(query, params);

      // Transform to TagInfo format
      const tagInfos: TagInfo[] = result.recordset.map(row => ({
        name: row.name,
        description: row.description || '',
        units: row.units || '',
        dataType: row.dataType,
        lastUpdate: new Date(row.lastUpdate),
        minValue: row.minValue,
        maxValue: row.maxValue
      }));

      // Cache the result if caching is enabled (AVEVA tags only — see the fresh-fetch
      // note on the cache-hit path above for why Tensor tags aren't cached here)
      if (this.cacheService && tagInfos.length > 0) {
        if (filter) {
          await this.cacheService.cacheFilteredTags(filter, tagInfos);
        } else {
          await this.cacheService.cacheTagList(tagInfos);
        }
      }

      const tensorTags = this.filterTensorTags(await this.getTensorTagList(), filter);
      const allTags = [...tagInfos, ...tensorTags];

      dbLogger.info(`Retrieved ${allTags.length} tags (${tagInfos.length} AVEVA, ${tensorTags.length} Tensor)`);
      return allTags;

    } catch (error) {
      dbLogger.error('Failed to retrieve tag list:', error);
      throw error;
    }
  }

  /**
   * Get metadata for a specific tag
   */
  async getTagInfo(tagName: string): Promise<TagInfo | null> {
    if (tagName.startsWith('tensor:')) {
      // TEVE doesn't carry AVEVA-style tag metadata (engineering units
      // catalog, min/max range) — the identifier itself (tensor:System.TagName) plus
      // whatever unit came back from /api/teve/tags is all there is.
      const tags = await this.getTensorTagList();
      const match = tags.find(t => t.name === tagName);
      if (match) return match;
      return {
        name: tagName,
        description: '',
        units: '',
        dataType: 'analog',
        lastUpdate: new Date(),
        dataSource: 'tensor'
      };
    }
    if (tagName.startsWith('opcua:')) {
      try {
        const resolved = opcuaManager.tryResolveTag(tagName);
        if (!resolved) {
          dbLogger.warn(NO_CONNECTION_MESSAGE, { tagName });
          return {
            name: tagName,
            description: NO_CONNECTION_MESSAGE,
            units: '',
            dataType: 'analog',
            lastUpdate: new Date(),
            minValue: 0,
            maxValue: 100,
            dataSource: 'opcua'
          };
        }
        const { connectionId, nodeId } = resolved;
        const data = await opcuaManager.getProvider(connectionId).readVariable(nodeId);
        let description = data.description;
        let units = '';

        // Fallback to Historian if description or units are empty
        const fallback = await this.getHistorianMetadataFallback(nodeId);
        if (fallback) {
          if (!description || description.trim() === '') {
            description = fallback.description;
          }
          if (fallback.units) {
            units = fallback.units;
          }
        }

        return {
          name: tagName,
          description: description || data.displayName || '',
          units: units,
          dataType: 'analog',
          lastUpdate: new Date(),
          minValue: 0,
          maxValue: 100,
          dataSource: 'opcua',
          opcuaNodeId: nodeId
        };
      } catch (error) {
        dbLogger.warn('Failed to fetch OPC UA tag info', { tagName, error: error instanceof Error ? error.message : 'Unknown error' });
        return {
          name: tagName,
          description: '',
          units: '',
          dataType: 'analog',
          lastUpdate: new Date(),
          minValue: 0,
          maxValue: 100,
          dataSource: 'opcua'
        };
      }
    }
    try {
      dbLogger.info('Retrieving info for tag', { tagName });

      const query = `
        SELECT 
          t.TagName as name,
          t.Description as description,
          eu.Unit as units,
          CASE 
            WHEN t.TagType = 1 THEN 'analog'
            WHEN t.TagType = 2 THEN 'discrete'
            WHEN t.TagType = 3 THEN 'string'
            ELSE 'unknown'
          END as dataType,
          t.DateCreated as lastUpdate,
          at.MinEU as minValue,
          at.MaxEU as maxValue
        FROM Tag t
        LEFT JOIN AnalogTag at ON t.TagName = at.TagName
        LEFT JOIN EngineeringUnit eu ON at.EUKey = eu.EUKey
        WHERE t.TagName = @tagName
      `;

      const result = await this.getConnection().executeQuery<any>(query, { tagName });

      if (result.recordset.length === 0) {
        return null;
      }

      const row = result.recordset[0];
      return {
        name: row.name,
        description: row.description || '',
        units: row.units || '',
        dataType: row.dataType,
        lastUpdate: new Date(row.lastUpdate),
        minValue: row.minValue,
        maxValue: row.maxValue
      };

    } catch (error) {
      dbLogger.error('Failed to retrieve tag info:', error);
      throw error;
    }
  }

  /**
   * Get filtered time-series data with pagination
   */
  async getFilteredData(
    timeRange: TimeRange,
    filter: DataFilter,
    pageSize: number = 1000,
    cursor?: string
  ): Promise<QueryResult<TimeSeriesData>> {
    try {
      dbLogger.info('Retrieving filtered data', { timeRange, filter, pageSize, cursor });

      // Validate inputs
      this.validateTimeRange(timeRange);
      this.validateDataFilter(filter);

      // Build filtered query
      const query = this.buildFilteredQuery(timeRange, filter, pageSize, cursor);
      const params = this.buildFilteredQueryParams(timeRange, filter, cursor);

      const result = await this.getConnection().executeQuery<any>(query, params);

      // Transform and paginate results
      const data = result.recordset.map(row => this.transformToTimeSeriesData(row));
      const hasMore = data.length === pageSize;
      const nextCursor = hasMore && data.length > 0 ? this.generateCursor(data[data.length - 1]!) : undefined;

      // Get total count for pagination info
      const countQuery = this.buildCountQuery(timeRange, filter);
      const countResult = await this.getConnection().executeQuery<{ total: number }>(countQuery, params);
      const totalCount = countResult.recordset[0]?.total || 0;

      return {
        data,
        totalCount,
        hasMore,
        ...(nextCursor && { nextCursor })
      };

    } catch (error) {
      dbLogger.error('Failed to retrieve filtered data:', error);
      throw error;
    }
  }

  /**
   * Build time-series query based on retrieval mode (legacy fallback)
   */
  private buildTimeSeriesQuery(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions
  ): string {
    return this.buildOptimizedTimeSeriesQuery(tagName, timeRange, options);
  }

  /**
   * Helper to retrieve Historian metadata fallback (Description, Units) for an OPC UA tag
   */
  private async getHistorianMetadataFallback(nodeId: string): Promise<{ description?: string; units?: string } | null> {
    try {
      // This is optional enrichment for an OPC UA-sourced value — never worth
      // paying executeQuery()'s connect-and-retry cost for. Skip immediately
      // (rather than attempting and letting it retry/time out) when Historian
      // isn't already connected; an unconfigured Historian won't become
      // configured mid-retry, so waiting here only stalls the OPC UA read that
      // triggered this lookup.
      if (!this.getConnection().getConnectionStatus().connected) return null;

      // Extract base name after the last dot
      const lastDotIndex = nodeId.lastIndexOf('.');
      const baseName = lastDotIndex !== -1 ? nodeId.substring(lastDotIndex + 1) : nodeId;

      if (!baseName || baseName.trim() === '') return null;

      dbLogger.debug(`Searching Historian fallback for base name: ${baseName}`);

      // We search for tags ending with the same base name
      // Join with EngineeringUnit via AnalogTag to get units
      const query = `
        SELECT TOP 1 t.Description, eu.Unit
        FROM Tag t
        LEFT JOIN AnalogTag at ON t.TagName = at.TagName
        LEFT JOIN EngineeringUnit eu ON at.EUKey = eu.EUKey
        WHERE (t.TagName LIKE @pattern1 OR t.TagName = @pattern2)
        AND (t.Description IS NOT NULL AND t.Description <> '' OR eu.Unit IS NOT NULL AND eu.Unit <> '')
      `;

      const result = await this.getConnection().executeQuery<any>(query, {
        pattern1: `%.${baseName}`,
        pattern2: baseName
      });

      if (result.recordset && result.recordset.length > 0) {
        return {
          description: result.recordset[0].Description || undefined,
          units: result.recordset[0].Unit || undefined
        };
      }

      return null;
    } catch (error) {
      dbLogger.warn('Failed to fetch Historian metadata fallback', {
        nodeId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Helper to retrieve OPC UA data for time-series format
   */
  private async getOpcuaTimeSeriesData(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions
  ): Promise<TimeSeriesData[]> {
    try {
      const { getQualityLabel: qLabel, getQualityMeaning: qMeaning } = require('@/utils/qualityUtils');
      const resolved = opcuaManager.tryResolveTag(tagName);
      if (!resolved) {
        // Legacy fallback is off (by default): surface an explicit Bad point
        // rather than silently binding the tag to some connection.
        dbLogger.warn(NO_CONNECTION_MESSAGE, { tagName });
        return [{
          timestamp: new Date(),
          value: null as any,
          quality: QualityCode.Bad,
          qualityLabel: qLabel(QualityCode.Bad),
          qualityMeaning: qMeaning(QualityCode.Bad),
          tagName,
          description: NO_CONNECTION_MESSAGE,
          dataSource: 'opcua'
        }];
      }
      const { connectionId, nodeId } = resolved;
      const currentData = await opcuaManager.getProvider(connectionId).readVariable(nodeId);

      const timestamp = new Date();
      const rawValue = currentData.value;

      // Try to parse as number if it's numeric, otherwise keep as is
      let value = rawValue;
      if (typeof rawValue === 'string' && !isNaN(Number(rawValue))) {
        value = Number(rawValue);
      } else if (typeof rawValue === 'boolean') {
        value = rawValue ? 1 : 0;
      }

      let description = currentData.description;

      // Fallback to Historian if description is empty
      if (!description || description.trim() === '') {
        const fallback = await this.getHistorianMetadataFallback(nodeId);
        if (fallback && fallback.description) {
          description = fallback.description;
        }
      }

      const quality = currentData.quality === 'Good' ? QualityCode.Good : QualityCode.Bad;
      const { getQualityLabel, getQualityMeaning } = require('@/utils/qualityUtils');

      // Stage 1: Only current value is supported for OPC UA
      // We return it as a single point at the current time
      return [{
        timestamp,
        value: value as any, // Cast to any because TimeSeriesData expects number but we support strings in ValueBlocks
        quality,
        qualityLabel: getQualityLabel(quality),
        qualityMeaning: getQualityMeaning(quality),
        tagName: tagName,
        description: description || currentData.displayName || '',
        dataSource: 'opcua'
      }];
    } catch (error) {
      dbLogger.warn('Failed to read OPC UA value', { tagName, error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    }
  }

  /**
   * Helper to retrieve time-series data from TEVE — a separate, optional,
   * admin-configured historian (see teveConfigService), reached only via its configured
   * baseUrl (never a direct DB connection, same boundary as the browser-facing proxy).
   * Tag identifier format: tensor:<scadaSystemId>.<tagName>.
   */
  private async getTensorTimeSeriesData(
    tagName: string,
    timeRange: TimeRange
  ): Promise<TimeSeriesData[]> {
    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) {
      dbLogger.warn('TEVE tag requested but the service is not enabled/configured', { tagName });
      return [];
    }

    const tag = tagName.replace('tensor:', '');
    if (!tag.includes('.')) {
      dbLogger.warn('Invalid TEVE tag format, expected tensor:System.TagName', { tagName });
      return [];
    }

    try {
      const params = new URLSearchParams({
        tag,
        from: timeRange.startTime.toISOString(),
        to: timeRange.endTime.toISOString()
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/teve/data?${params.toString()}`, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        dbLogger.warn(`TEVE data request returned ${res.status}`, { tagName });
        return [];
      }
      const body = await res.json() as { data: Array<{ DateTime: string; Value: number | null; Status: string }> };
      const { getQualityLabel, getQualityMeaning } = require('@/utils/qualityUtils');

      return body.data
        .filter(row => row.Value !== null)
        .map(row => {
          const quality = row.Status === 'Good' ? QualityCode.Good : QualityCode.Bad;
          return {
            timestamp: new Date(row.DateTime),
            value: Number(row.Value),
            quality,
            qualityLabel: getQualityLabel(quality),
            qualityMeaning: getQualityMeaning(quality),
            tagName,
            dataSource: 'tensor' as const
          };
        })
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch (error) {
      dbLogger.warn('Failed to read TEVE data', { tagName, error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    }
  }

  /**
   * List available TEVE tags (tensor:<scadaSystemId>.<tagName>), for use
   * alongside AVEVA tags in report/dashboard tag pickers. Returns [] when the service
   * is disabled/unconfigured or unreachable — never throws, so callers merging this
   * into a broader tag list don't need special-case handling.
   */
  async getTensorTagList(): Promise<TagInfo[]> {
    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) return [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/teve/tags`, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        dbLogger.warn(`TEVE tag list request returned ${res.status}`);
        return [];
      }
      const body = await res.json() as { tags: Array<{ tag_id: string; tag_unit: string | null }> };
      return body.tags.map(t => ({
        name: `tensor:${t.tag_id}`,
        description: '',
        units: t.tag_unit || '',
        dataType: 'analog' as const,
        lastUpdate: new Date(),
        dataSource: 'tensor' as const
      }));
    } catch (error) {
      dbLogger.warn('Failed to retrieve TEVE tag list', { error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    }
  }

  /** Case-insensitive substring match on name, mirroring the AVEVA tag-list filter's semantics. */
  private filterTensorTags(tags: TagInfo[], filter?: string): TagInfo[] {
    if (!filter) return tags;
    const needle = filter.toUpperCase();
    return tags.filter(t => t.name.toUpperCase().includes(needle));
  }

  /**
   * Format date for AVEVA Historian in UTC
   */
  private formatDateForHistorian(date: Date): string {
    // AVEVA Historian expects date format: 'YYYY-MM-DD HH:mm:ss'
    // We use UTC methods to ensure consistency regardless of process timezone
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Build query parameters
   */
  private buildQueryParams(
    tagName: string,
    timeRange: TimeRange,
    options?: HistorianQueryOptions
  ): Record<string, any> {
    const mode = options?.mode || RetrievalMode.Full;

    if (mode === RetrievalMode.Live) {
      return { tagName };
    }

    const params: Record<string, any> = {
      tagName,
      startTime: this.formatDateForHistorian(timeRange.startTime),
      endTime: this.formatDateForHistorian(timeRange.endTime),
      mode: mode
    };

    // Calculate or use provided resolution
    if (options?.resolution) {
      params.resolution = options.resolution;
    } else if (options?.interval) {
      params.resolution = options.interval * 1000; // Convert seconds to milliseconds
    } else if (mode === RetrievalMode.Cyclic || mode === RetrievalMode.Average) {
      // Default to 1000 points for resolution calculation if not specified (safe performance default)
      const durationMs = timeRange.endTime.getTime() - timeRange.startTime.getTime();
      const defaultPoints = options?.maxPoints || 1000;
      params.resolution = Math.max(1, Math.floor(durationMs / defaultPoints));
    }

    if (options?.maxPoints) {
      params.maxPoints = options.maxPoints;
    }

    // Add quality filter parameters
    if (options?.qualityFilter && options.qualityFilter.length > 0) {
      options.qualityFilter.forEach((quality, index) => {
        params[`quality${index}`] = quality;
      });
    }

    return params;
  }

  /**
   * Build filtered query with multiple conditions
   */
  private buildFilteredQuery(
    timeRange: TimeRange,
    filter: DataFilter,
    pageSize: number,
    cursor?: string
  ): string {
    let query = `
      SELECT TOP ${pageSize + 1}
        DateTime as timestamp,
        Value as value,
        Quality as quality,
        TagName as tagName
      FROM History
      WHERE DateTime >= @startTime
        AND DateTime <= @endTime
        AND wwRetrievalMode = 'Delta'
        AND wwTimeZone = 'UTC'
        AND wwVersion = 'Latest'
    `;

    if (filter.samplingInterval) {
      query += ` AND wwResolution = @resolution`;
    }

    // Add tag name filter
    if (filter.tagNames && filter.tagNames.length > 0) {
      const tagPlaceholders = filter.tagNames.map((_, index) => `@tag${index}`).join(',');
      query += ` AND TagName IN (${tagPlaceholders})`;
    }

    // Add quality filter
    if (filter.qualityFilter && filter.qualityFilter.length > 0) {
      const qualityPlaceholders = filter.qualityFilter.map((_, index) => `@quality${index}`).join(',');
      query += ` AND Quality IN (${qualityPlaceholders})`;
    }

    // Add value range filter
    if (filter.valueRange) {
      if (filter.valueRange.min !== undefined) {
        query += ` AND Value >= @minValue`;
      }
      if (filter.valueRange.max !== undefined) {
        query += ` AND Value <= @maxValue`;
      }
    }

    // Add advanced recursive filters
    if (filter.advancedConditions) {
      const paramCounter = { count: 0 };
      const advancedSql = this.translateConditionToSql(filter.advancedConditions, paramCounter);
      if (advancedSql) {
        query += ` AND (${advancedSql})`;
      }
    }

    // Add cursor for pagination
    if (cursor) {
      query += ` AND DateTime > @cursorTime`;
    }

    query += ` ORDER BY DateTime, TagName`;

    return query;
  }

  /**
   * Translate recursive filter condition to SQL WHERE clause
   */
  private translateConditionToSql(condition: FilterCondition, paramCounter: { count: number }): string {
    if (condition.comparison) {
      const { operator, value } = condition.comparison;
      const paramName = `advParam${paramCounter.count++}`;
      
      let sqlOp = '';
      switch (operator) {
        case 'EQ': sqlOp = '='; break;
        case 'GT': sqlOp = '>'; break;
        case 'LT': sqlOp = '<'; break;
        case 'GTE': sqlOp = '>='; break;
        case 'LTE': sqlOp = '<='; break;
        case 'NEQ': sqlOp = '<>'; break;
        default: return '';
      }
      
      return `Value ${sqlOp} @${paramName}`;
    }

    if (condition.logicalOperator && condition.conditions) {
      const { logicalOperator, conditions } = condition;
      const subSqls = conditions
        .map(c => this.translateConditionToSql(c, paramCounter))
        .filter(s => s !== '');

      if (subSqls.length === 0) return '';

      const joinOp = logicalOperator === 'NOR' ? 'OR' : logicalOperator;
      const joined = subSqls.join(` ${joinOp} `);

      switch (logicalOperator) {
        case 'AND':
        case 'OR':
          return `(${joined})`;
        case 'NOR':
        case 'NOT':
          return `NOT (${joined})`;
        default:
          return '';
      }
    }

    return '';
  }


  /**
   * Build parameters for filtered query
   */
  private buildFilteredQueryParams(
    timeRange: TimeRange,
    filter: DataFilter,
    cursor?: string
  ): Record<string, any> {
    const params: Record<string, any> = {
      startTime: this.formatDateForHistorian(timeRange.startTime),
      endTime: this.formatDateForHistorian(timeRange.endTime),
      mode: filter.samplingInterval ? RetrievalMode.Cyclic : RetrievalMode.Full
    };

    if (filter.samplingInterval) {
      params.resolution = filter.samplingInterval;
    }

    // Add tag name parameters
    if (filter.tagNames) {
      filter.tagNames.forEach((tagName, index) => {
        params[`tag${index}`] = tagName;
      });
    }

    // Add quality parameters
    if (filter.qualityFilter) {
      filter.qualityFilter.forEach((quality, index) => {
        params[`quality${index}`] = quality;
      });
    }

    // Add value range parameters
    if (filter.valueRange) {
      if (filter.valueRange.min !== undefined) {
        params.minValue = filter.valueRange.min;
      }
      if (filter.valueRange.max !== undefined) {
        params.maxValue = filter.valueRange.max;
      }
    }

    // Add advanced recursive filter parameters
    if (filter.advancedConditions) {
      const paramCounter = { count: 0 };
      this.addAdvancedQueryParams(filter.advancedConditions, params, paramCounter);
    }

    // Add cursor parameter
    if (cursor) {
      params.cursorTime = new Date(cursor);
    }

    return params;
  }

  /**
   * Add parameters for advanced recursive filters
   */
  private addAdvancedQueryParams(condition: FilterCondition, params: Record<string, any>, paramCounter: { count: number }): void {
    if (condition.comparison) {
      const paramName = `advParam${paramCounter.count++}`;
      params[paramName] = condition.comparison.value;
    }

    if (condition.conditions) {
      condition.conditions.forEach(c => this.addAdvancedQueryParams(c, params, paramCounter));
    }
  }


  /**
   * Build count query for pagination
   */
  private buildCountQuery(timeRange: TimeRange, filter: DataFilter): string {
    let query = `
      SELECT COUNT(*) as total
      FROM History
      WHERE DateTime >= @startTime
        AND DateTime <= @endTime
        AND wwTimeZone = 'UTC'
        AND wwVersion = 'Latest'
    `;

    // Add same filters as main query (without cursor)
    if (filter.tagNames && filter.tagNames.length > 0) {
      const tagPlaceholders = filter.tagNames.map((_, index) => `@tag${index}`).join(',');
      query += ` AND TagName IN (${tagPlaceholders})`;
    }

    if (filter.qualityFilter && filter.qualityFilter.length > 0) {
      const qualityPlaceholders = filter.qualityFilter.map((_, index) => `@quality${index}`).join(',');
      query += ` AND Quality IN (${qualityPlaceholders})`;
    }

    if (filter.valueRange) {
      if (filter.valueRange.min !== undefined) {
        query += ` AND Value >= @minValue`;
      }
      if (filter.valueRange.max !== undefined) {
        query += ` AND Value <= @maxValue`;
      }
    }

    // Add advanced recursive filters
    if (filter.advancedConditions) {
      const paramCounter = { count: 0 };
      const advancedSql = this.translateConditionToSql(filter.advancedConditions, paramCounter);
      if (advancedSql) {
        query += ` AND (${advancedSql})`;
      }
    }

    return query;
  }


  /**
   * Transform raw database row to TimeSeriesData
   */
  private transformToTimeSeriesData(row: any, tagName?: string): TimeSeriesData {
    const { getQualityLabel, getQualityMeaning } = require('@/utils/qualityUtils');
    
    // Handle null values - convert to NaN to indicate missing data
    const value = row.value !== null && row.value !== undefined ? parseFloat(row.value) : NaN;
    const quality = row.quality !== null && row.quality !== undefined ? row.quality : QualityCode.Good;

    return {
      timestamp: new Date(row.timestamp),
      value: value,
      quality: quality,
      qualityLabel: getQualityLabel(quality),
      qualityMeaning: getQualityMeaning(quality),
      tagName: tagName || row.tagName
    };
  }



  /**
   * Generate cursor for pagination
   */
  private generateCursor(data: TimeSeriesData): string {
    return data.timestamp.toISOString();
  }

  /**
   * Validate time range
   */
  private validateTimeRange(timeRange: TimeRange): void {
    if (!timeRange.startTime || !timeRange.endTime) {
      throw createError('Start time and end time are required', 400);
    }

    if (timeRange.startTime >= timeRange.endTime) {
      throw createError('Start time must be before end time', 400);
    }

    // Check for reasonable time range (not more than 1 year)
    const maxDuration = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
    const duration = timeRange.endTime.getTime() - timeRange.startTime.getTime();

    if (duration > maxDuration) {
      throw createError('Time range cannot exceed 1 year', 400);
    }
  }

  /**
   * Validate tag name
   */
  private validateTagName(tagName: string): void {
    if (!tagName || tagName.trim().length === 0) {
      throw createError('Tag name is required', 400);
    }

    // Basic validation for tag name format
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(tagName)) {
      throw createError('Invalid tag name format', 400);
    }
  }

  /**
   * Validate data filter
   */
  private validateDataFilter(filter: DataFilter): void {
    if (filter.valueRange) {
      if (filter.valueRange.min !== undefined && filter.valueRange.max !== undefined) {
        if (filter.valueRange.min >= filter.valueRange.max) {
          throw createError('Minimum value must be less than maximum value', 400);
        }
      }
    }

    if (filter.samplingInterval && filter.samplingInterval <= 0) {
      throw createError('Sampling interval must be positive', 400);
    }
  }
}

// Export singleton instance
export const dataRetrievalService = new DataRetrievalService();