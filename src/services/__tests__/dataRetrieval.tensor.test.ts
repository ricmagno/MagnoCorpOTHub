import { DataRetrievalService } from '../dataRetrieval';
import { QualityCode, TimeRange } from '@/types/historian';

jest.mock('@/utils/logger', () => ({
  dbLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../teveConfigService', () => ({
  teveConfigService: { getActiveBaseUrl: jest.fn() }
}));

jest.mock('../historianConnection', () => ({
  getHistorianConnection: jest.fn(() => ({
    executeQuery: jest.fn().mockResolvedValue({ recordset: [] })
  }))
}));

jest.mock('../opcuaService', () => ({
  opcuaService: { readVariable: jest.fn() }
}));

import { teveConfigService } from '../teveConfigService';
import { getHistorianConnection } from '../historianConnection';

const mockTeveConfig = teveConfigService as jest.Mocked<typeof teveConfigService>;
const mockGetHistorianConnection = getHistorianConnection as jest.Mock;

const TIME_RANGE: TimeRange = {
  startTime: new Date('2026-01-01T00:00:00.000Z'),
  endTime: new Date('2026-01-01T01:00:00.000Z')
};

describe('DataRetrievalService — TEVE routing', () => {
  let service: DataRetrievalService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DataRetrievalService();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    mockTeveConfig.getActiveBaseUrl.mockReturnValue('http://historian.local:3100');
  });

  describe('getTimeSeriesData("tensor:...")', () => {
    it('fetches from the TEVE data endpoint and maps the response', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          tag: 'opcua-plant-a.Reactor1.Temperature',
          count: 2,
          data: [
            { DateTime: '2026-01-01T00:30:00.000Z', Value: 72.5, Status: 'Good' },
            { DateTime: '2026-01-01T00:00:00.000Z', Value: 71.0, Status: 'Good' }
          ]
        })
      });

      const result = await service.getTimeSeriesData('tensor:opcua-plant-a.Reactor1.Temperature', TIME_RANGE);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain('http://historian.local:3100/api/teve/data?');
      expect(url).toContain('tag=opcua-plant-a.Reactor1.Temperature');

      // sorted ascending by timestamp
      expect(result).toHaveLength(2);
      expect(result[0]!.timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(result[1]!.timestamp.toISOString()).toBe('2026-01-01T00:30:00.000Z');
      expect(result[0]!.value).toBe(71.0);
      expect(result[0]!.quality).toBe(QualityCode.Good);
      expect(result[0]!.dataSource).toBe('tensor');
    });

    it('maps a non-"Good" status to Bad quality', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          tag: 'sys.Tag1',
          count: 1,
          data: [{ DateTime: '2026-01-01T00:00:00.000Z', Value: 1, Status: 'Stale' }]
        })
      });

      const result = await service.getTimeSeriesData('tensor:sys.Tag1', TIME_RANGE);
      expect(result[0]!.quality).toBe(QualityCode.Bad);
    });

    it('filters out rows with a null value', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          tag: 'sys.Tag1',
          count: 2,
          data: [
            { DateTime: '2026-01-01T00:00:00.000Z', Value: null, Status: 'Good' },
            { DateTime: '2026-01-01T00:01:00.000Z', Value: 5, Status: 'Good' }
          ]
        })
      });

      const result = await service.getTimeSeriesData('tensor:sys.Tag1', TIME_RANGE);
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe(5);
    });

    it('returns [] without fetching when TEVE is not enabled/configured', async () => {
      mockTeveConfig.getActiveBaseUrl.mockReturnValue(null);

      const result = await service.getTimeSeriesData('tensor:sys.Tag1', TIME_RANGE);

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns [] without fetching for a malformed tag (no System.TagName dot)', async () => {
      const result = await service.getTimeSeriesData('tensor:NoDotHere', TIME_RANGE);

      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns [] when the request fails (non-ok response)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await service.getTimeSeriesData('tensor:sys.Tag1', TIME_RANGE);
      expect(result).toEqual([]);
    });

    it('returns [] and does not throw when fetch itself rejects', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      const result = await service.getTimeSeriesData('tensor:sys.Tag1', TIME_RANGE);
      expect(result).toEqual([]);
    });

    it('does not query AVEVA Historian for tensor: tags', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tag: 'sys.Tag1', count: 0, data: [] }) });

      await service.getTimeSeriesData('tensor:sys.Tag1', TIME_RANGE);

      expect(mockGetHistorianConnection).not.toHaveBeenCalled();
    });
  });

  describe('getMultipleTimeSeriesData', () => {
    it('splits tensor: tags out and merges their results back by tag name', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          tag: 'sys.Tag1',
          count: 1,
          data: [{ DateTime: '2026-01-01T00:00:00.000Z', Value: 9, Status: 'Good' }]
        })
      });

      const results = await service.getMultipleTimeSeriesData(['tensor:sys.Tag1'], TIME_RANGE);

      expect(Object.keys(results)).toEqual(['tensor:sys.Tag1']);
      expect(results['tensor:sys.Tag1']).toHaveLength(1);
      expect(mockGetHistorianConnection).not.toHaveBeenCalled();
    });

    it('does not let a failed tensor tag affect the result set (empty array, not thrown)', async () => {
      fetchMock.mockRejectedValue(new Error('boom'));

      const results = await service.getMultipleTimeSeriesData(['tensor:sys.Tag1'], TIME_RANGE);

      expect(results['tensor:sys.Tag1']).toEqual([]);
    });
  });

  describe('getTagInfo("tensor:...")', () => {
    it('returns tag info matched from the TEVE tag list, including its unit', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          count: 1,
          tags: [{ tag_id: 'opcua-plant-a.Reactor1.Temperature', scada_system_id: 'opcua-plant-a', tag_name: 'Reactor1.Temperature', tag_unit: 'degC' }]
        })
      });

      const info = await service.getTagInfo('tensor:opcua-plant-a.Reactor1.Temperature');

      expect(info).toMatchObject({
        name: 'tensor:opcua-plant-a.Reactor1.Temperature',
        units: 'degC',
        dataSource: 'tensor'
      });
    });

    it('falls back to a synthesized TagInfo when the tag is not in the list (e.g. TEVE unreachable)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const info = await service.getTagInfo('tensor:sys.Unknown');

      expect(info).toMatchObject({ name: 'tensor:sys.Unknown', dataSource: 'tensor', units: '', description: '' });
    });
  });

  describe('getStatistics("tensor:...")', () => {
    it('computes statistics client-side from fetched TEVE points', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          tag: 'sys.Tag1',
          count: 3,
          data: [
            { DateTime: '2026-01-01T00:00:00.000Z', Value: 10, Status: 'Good' },
            { DateTime: '2026-01-01T00:01:00.000Z', Value: 20, Status: 'Good' },
            { DateTime: '2026-01-01T00:02:00.000Z', Value: 30, Status: 'Good' }
          ]
        })
      });

      const stats = await service.getStatistics('tensor:sys.Tag1', TIME_RANGE);

      expect(stats.count).toBe(3);
      expect(stats.average).toBeCloseTo(20);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(30);
    });

    it('returns zeroed statistics (not an error) when there is no data', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tag: 'sys.Tag1', count: 0, data: [] }) });

      const stats = await service.getStatistics('tensor:sys.Tag1', TIME_RANGE);

      expect(stats).toEqual({ average: 0, min: 0, max: 0, median: 0, standardDeviation: 0, count: 0, dataQuality: 0 });
    });

    it('does not query AVEVA Historian for tensor: tags', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tag: 'sys.Tag1', count: 0, data: [] }) });

      await service.getStatistics('tensor:sys.Tag1', TIME_RANGE);

      expect(mockGetHistorianConnection).not.toHaveBeenCalled();
    });
  });

  describe('getTensorTagList', () => {
    it('maps the TEVE tag catalog into TagInfo entries prefixed with tensor:', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          count: 2,
          tags: [
            { tag_id: 'sys.A', scada_system_id: 'sys', tag_name: 'A', tag_unit: 'degC' },
            { tag_id: 'sys.B', scada_system_id: 'sys', tag_name: 'B', tag_unit: null }
          ]
        })
      });

      const tags = await service.getTensorTagList();

      expect(tags).toHaveLength(2);
      expect(tags[0]).toMatchObject({ name: 'tensor:sys.A', units: 'degC', dataSource: 'tensor' });
      expect(tags[1]).toMatchObject({ name: 'tensor:sys.B', units: '' });
    });

    it('returns [] without fetching when TEVE is not configured', async () => {
      mockTeveConfig.getActiveBaseUrl.mockReturnValue(null);

      const tags = await service.getTensorTagList();

      expect(tags).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
