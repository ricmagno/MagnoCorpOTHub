import { OpcuaDataValue } from '@/types/opcua';

jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../opcua/opcuaConnectionManager', () => ({
  opcuaManager: {
    onAnyConnect: jest.fn(),
    onAnyReconnect: jest.fn(),
    listProviders: jest.fn(),
    findProvider: jest.fn(),
    terminateSubscriptionAll: jest.fn(),
    getLegacyDefaultConnectionId: jest.fn(),
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

const TAGS = [{ nodeId: 'ns=2;s=Tag1', connectionId: 'cfg1', tagName: 'Tag1', unit: 'degC', createdAt: '2026-01-01T00:00:00.000Z' }];

/** Drains a chain of several sequential awaits (e.g. stop() -> flush() -> setupSubscriptions()). */
async function flushAsync(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function makeDataValue(value: unknown, statusName = 'Good'): OpcuaDataValue {
  return {
    value,
    statusName,
    sourceTimestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('TeveIngestService', () => {
  let fetchMock: jest.Mock;
  let mockManager: { [K in keyof typeof import('../opcua/opcuaConnectionManager').opcuaManager]: jest.Mock };
  let mockProvider: {
    connectionId: string;
    name: string;
    hasSession: jest.Mock;
    createSubscription: jest.Mock;
    monitorNode: jest.Mock;
    terminateSubscription: jest.Mock;
  };
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

  // jest.resetModules() gives each test a fresh singleton (isolating flushTimer/pending
  // state), but that means the mocked deps must also be re-required AFTER the reset —
  // grabbing them via the file-level `import` would bind to a stale pre-reset copy
  // that the freshly-loaded service never actually calls.
  const load = () => {
    jest.resetModules();
    mockManager = require('../opcua/opcuaConnectionManager').opcuaManager;
    mockTeveConfig = require('../teveConfigService').teveConfigService;
    mockTeveTagConfig = require('../teveTagConfigService').teveTagConfigService;

    mockProvider = {
      connectionId: 'cfg1',
      name: 'Plant A',
      hasSession: jest.fn().mockReturnValue(true),
      createSubscription: jest.fn().mockResolvedValue(undefined),
      monitorNode: jest.fn().mockResolvedValue({ id: 'm1', dispose: jest.fn() }),
      terminateSubscription: jest.fn().mockResolvedValue(undefined),
    };

    mockManager.listProviders.mockReturnValue([mockProvider]);
    mockManager.findProvider.mockImplementation((id: string) => (id === 'cfg1' ? mockProvider : null));
    mockManager.terminateSubscriptionAll.mockResolvedValue(undefined);
    mockManager.getLegacyDefaultConnectionId.mockReturnValue(null);
    mockTeveConfig.getActiveBaseUrl.mockReturnValue('http://historian.local:3100');
    mockTeveTagConfig.list.mockReturnValue(TAGS);

    return require('../teveIngestService').teveIngestService as typeof import('../teveIngestService').teveIngestService;
  };

  it('registers connect/reconnect callbacks and sets up immediately when a session already exists', async () => {
    const service = load();
    await service.start();

    expect(mockManager.onAnyConnect).toHaveBeenCalledTimes(1);
    expect(mockManager.onAnyReconnect).toHaveBeenCalledTimes(1);
    expect(mockProvider.createSubscription).toHaveBeenCalledWith('teve-ingest', 1000);
    expect(mockProvider.monitorNode).toHaveBeenCalledWith('teve-ingest', 'ns=2;s=Tag1', 1000, expect.any(Function));
  });

  it('does not set up subscriptions immediately when no session exists yet', async () => {
    const service = load();
    mockProvider.hasSession.mockReturnValue(false);
    await service.start();

    expect(mockProvider.createSubscription).not.toHaveBeenCalled();
  });

  it('runs setup via the registered onAnyConnect callback once a session appears', async () => {
    const service = load();
    mockProvider.hasSession.mockReturnValue(false);
    await service.start();

    mockProvider.hasSession.mockReturnValue(true);
    const onConnectCb = mockManager.onAnyConnect.mock.calls[0]![0];
    onConnectCb('cfg1');
    await flushAsync();

    expect(mockProvider.createSubscription).toHaveBeenCalledWith('teve-ingest', 1000);
  });

  it('skips setup when TEVE is not enabled/configured', async () => {
    const service = load();
    mockTeveConfig.getActiveBaseUrl.mockReturnValue(null);
    await service.start();

    expect(mockProvider.createSubscription).not.toHaveBeenCalled();
  });

  it('skips setup when no tags are configured to historize', async () => {
    const service = load();
    mockTeveTagConfig.list.mockReturnValue([]);
    await service.start();

    expect(mockProvider.createSubscription).not.toHaveBeenCalled();
  });

  it('skips tags without a connection when no legacy-default connection is designated', async () => {
    const service = load();
    mockTeveTagConfig.list.mockReturnValue([
      { nodeId: 'ns=2;s=Orphan', connectionId: null, tagName: 'Orphan', unit: null, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await service.start();

    expect(mockProvider.createSubscription).not.toHaveBeenCalled();
  });

  it('routes unqualified tags through the legacy-default connection when designated', async () => {
    const service = load();
    mockManager.getLegacyDefaultConnectionId.mockReturnValue('cfg1');
    mockTeveTagConfigListLegacy();
    await service.start();

    expect(mockProvider.createSubscription).toHaveBeenCalledWith('teve-ingest', 1000);
    expect(mockProvider.monitorNode).toHaveBeenCalledWith('teve-ingest', 'ns=2;s=Orphan', 1000, expect.any(Function));

    function mockTeveTagConfigListLegacy() {
      mockTeveTagConfig.list.mockReturnValue([
        { nodeId: 'ns=2;s=Orphan', connectionId: null, tagName: 'Orphan', unit: null, createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    }
  });

  it('derives scadaSystem identity from the connection name', async () => {
    const service = load();
    mockProvider.name = 'Plant A!! 01';
    await service.start();

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
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

  it('enqueues monitored values and flushes them as a batch on the flush interval', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
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

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
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

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
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

  it('drops the pending batch without fetching if TEVE becomes disabled before flush', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
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

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
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

  it('stop() terminates subscriptions, clears the flush timer, and flushes remaining pending data', async () => {
    const service = load();
    await service.start();

    const monitorCb = mockProvider.monitorNode.mock.calls[0]![3];
    monitorCb(makeDataValue(1));

    await service.stop();

    expect(mockManager.terminateSubscriptionAll).toHaveBeenCalledWith('teve-ingest');
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
    mockProvider.createSubscription.mockClear();

    await service.refresh();

    expect(mockManager.terminateSubscriptionAll).toHaveBeenCalledWith('teve-ingest');
    expect(mockProvider.createSubscription).toHaveBeenCalledWith('teve-ingest', 1000);
  });

  it('onAnyReconnect callback refreshes only that connection', async () => {
    const service = load();
    await service.start();
    mockProvider.createSubscription.mockClear();

    const onReconnectCb = mockManager.onAnyReconnect.mock.calls[0]![0];
    onReconnectCb('cfg1');
    await flushAsync();

    expect(mockProvider.terminateSubscription).toHaveBeenCalledWith('teve-ingest');
    expect(mockProvider.createSubscription).toHaveBeenCalledWith('teve-ingest', 1000);
  });
});
