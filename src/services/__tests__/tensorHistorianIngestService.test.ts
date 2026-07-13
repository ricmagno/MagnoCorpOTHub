import { DataValue } from 'node-opcua';

jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../opcuaService', () => ({
  opcuaService: {
    onConnect: jest.fn(),
    onReconnect: jest.fn(),
    hasSession: jest.fn(),
    createSubscription: jest.fn(),
    monitorNode: jest.fn(),
    terminateSubscription: jest.fn(),
  },
}));

jest.mock('../opcuaConfigService', () => ({
  opcuaConfigService: {
    listConfigurations: jest.fn(),
    loadConfiguration: jest.fn(),
  },
}));

jest.mock('../teveConfigService', () => ({
  teveConfigService: {
    getActiveBaseUrl: jest.fn(),
  },
}));

jest.mock('../teveTagConfigService', () => ({
  teveTagConfigService: {
    list: jest.fn(),
  },
}));

const TAGS = [{ nodeId: 'ns=2;s=Tag1', tagName: 'Tag1', unit: 'degC', createdAt: '2026-01-01T00:00:00.000Z' }];

/** Drains a chain of several sequential awaits (e.g. stop() -> flush() -> setupSubscriptions()). */
async function flushAsync(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function makeDataValue(value: unknown, statusName = 'Good'): DataValue {
  return {
    value: { value },
    statusCode: { name: statusName },
    sourceTimestamp: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as DataValue;
}

describe('TensorHistorianIngestService', () => {
  let fetchMock: jest.Mock;
  let mockOpcua: { [K in keyof typeof import('../opcuaService').opcuaService]: jest.Mock };
  let mockOpcuaConfig: { [K in keyof typeof import('../opcuaConfigService').opcuaConfigService]: jest.Mock };
  let mockTeveConfig: { [K in keyof typeof import('../teveConfigService').teveConfigService]: jest.Mock };
  let mockTeveTagConfig: { [K in keyof typeof import('../teveTagConfigService').teveTagConfigService]: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // jest.resetModules() gives each test a fresh singleton (isolating flushTimer/pending/
  // scadaSystem state), but that means the mocked deps must also be re-required AFTER the
  // reset — grabbing them via the file-level `import` would bind to a stale pre-reset copy
  // that the freshly-loaded service never actually calls.
  const load = () => {
    jest.resetModules();
    mockOpcua = require('../opcuaService').opcuaService;
    mockOpcuaConfig = require('../opcuaConfigService').opcuaConfigService;
    mockTeveConfig = require('../teveConfigService').teveConfigService;
    mockTeveTagConfig = require('../teveTagConfigService').teveTagConfigService;

    mockOpcua.hasSession.mockReturnValue(true);
    mockOpcua.createSubscription.mockResolvedValue(undefined);
    mockOpcua.terminateSubscription.mockResolvedValue(undefined);
    mockTeveConfig.getActiveBaseUrl.mockReturnValue('http://historian.local:3100');
    mockTeveTagConfig.list.mockReturnValue(TAGS);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([{ id: 'cfg1', name: 'Plant A', isActive: true }]);
    mockOpcuaConfig.loadConfiguration.mockResolvedValue({ name: 'Plant A' });

    return require('../tensorHistorianIngestService').tensorHistorianIngestService as typeof import('../tensorHistorianIngestService').tensorHistorianIngestService;
  };

  it('registers connect/reconnect callbacks and sets up immediately when a session already exists', async () => {
    const service = load();
    await service.start();

    expect(mockOpcua.onConnect).toHaveBeenCalledTimes(1);
    expect(mockOpcua.onReconnect).toHaveBeenCalledTimes(1);
    expect(mockOpcua.createSubscription).toHaveBeenCalledWith('tensor-historian', 1000);
    expect(mockOpcua.monitorNode).toHaveBeenCalledWith('tensor-historian', 'ns=2;s=Tag1', 1000, expect.any(Function));
  });

  it('does not set up subscriptions immediately when no session exists yet', async () => {
    const service = load();
    mockOpcua.hasSession.mockReturnValue(false);
    await service.start();

    expect(mockOpcua.createSubscription).not.toHaveBeenCalled();
  });

  it('runs setup via the registered onConnect callback once a session appears', async () => {
    const service = load();
    mockOpcua.hasSession.mockReturnValue(false);
    await service.start();

    const onConnectCb = mockOpcua.onConnect.mock.calls[0]![0];
    onConnectCb();
    await flushAsync();

    expect(mockOpcua.createSubscription).toHaveBeenCalledWith('tensor-historian', 1000);
  });

  it('skips setup when Tensor Historian is not enabled/configured', async () => {
    const service = load();
    mockTeveConfig.getActiveBaseUrl.mockReturnValue(null);
    await service.start();

    expect(mockOpcua.createSubscription).not.toHaveBeenCalled();
  });

  it('skips setup when no tags are configured to historize', async () => {
    const service = load();
    mockTeveTagConfig.list.mockReturnValue([]);
    await service.start();

    expect(mockOpcua.createSubscription).not.toHaveBeenCalled();
  });

  it('derives scadaSystem identity from the active OPC UA config name', async () => {
    const service = load();
    mockOpcuaConfig.loadConfiguration.mockResolvedValue({ name: 'Plant A!! 01' });
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(42));
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://historian.local:3100/api/teve/ingest',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"id":"opcua-plant-a-01"'),
      })
    );
  });

  it('falls back to the generic identity when no active OPC UA config is resolvable', async () => {
    const service = load();
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockOpcuaConfig.loadConfiguration.mockRejectedValue(new Error('no config with id ""'));
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(1));
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    expect(body.scadaSystem).toEqual({ id: 'opcua-source', name: 'OPC UA Source' });
  });

  it('enqueues monitored values and flushes them as a batch on the flush interval', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(72.5));
    monitorCb(makeDataValue(73.1));

    expect(fetchMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    expect(body.metrics).toHaveLength(2);
    expect(body.metrics[0]).toMatchObject({ tagName: 'Tag1', value: 72.5, status: 'Good', unit: 'degC' });
  });

  it('maps boolean values to 1/0 and non-numeric/non-boolean values to null', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(true));
    monitorCb(makeDataValue(false));
    monitorCb(makeDataValue('unexpected-string'));

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    expect(body.metrics.map((m: any) => m.value)).toEqual([1, 0, null]);
  });

  it('maps a Bad/Uncertain-other status code to status "Bad"', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(1, 'Bad'));

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    expect(body.metrics[0].status).toBe('Bad');
  });

  it('does not flush when there is nothing pending', async () => {
    const service = load();
    await service.start();

    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the pending batch without fetching if Tensor Historian becomes disabled before flush', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(1));

    mockTeveConfig.getActiveBaseUrl.mockReturnValue(null);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows fetch failures without throwing (batch is dropped, not retried)', async () => {
    const service = load();
    fetchMock.mockRejectedValue(new Error('network down'));
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(1));

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Next flush should not resend the dropped batch.
    fetchMock.mockClear();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stop() terminates the subscription, clears the flush timer, and flushes remaining pending data', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockOpcua.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(1));

    await service.stop();

    expect(mockOpcua.terminateSubscription).toHaveBeenCalledWith('tensor-historian');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Timer should be cleared — advancing time triggers no further flush.
    fetchMock.mockClear();
    jest.advanceTimersByTime(10000);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refresh() stops and re-establishes subscriptions', async () => {
    const service = load();
    await service.start();
    mockOpcua.createSubscription.mockClear();

    await service.refresh();

    expect(mockOpcua.terminateSubscription).toHaveBeenCalledWith('tensor-historian');
    expect(mockOpcua.createSubscription).toHaveBeenCalledWith('tensor-historian', 1000);
  });

  it('onReconnect callback triggers a refresh', async () => {
    const service = load();
    await service.start();
    mockOpcua.createSubscription.mockClear();

    const onReconnectCb = mockOpcua.onReconnect.mock.calls[0]![0];
    onReconnectCb();
    await flushAsync();

    expect(mockOpcua.terminateSubscription).toHaveBeenCalledWith('tensor-historian');
    expect(mockOpcua.createSubscription).toHaveBeenCalledWith('tensor-historian', 1000);
  });
});
