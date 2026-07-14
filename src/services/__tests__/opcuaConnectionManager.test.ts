import { OpcuaConnectionManager, ResolvedOpcuaConfig } from '../opcua/opcuaConnectionManager';
import { OpcuaConnectionProvider, OpcuaDataValue, MonitorHandle } from '@/types/opcua';

jest.mock('node-opcua', () => ({
    OPCUACertificateManager: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@/config/environment', () => ({
    getDatabasePath: jest.fn().mockReturnValue('/mock/path/pki'),
    env: {
        OPCUA_MAX_CONNECTIONS: 3,
        OPCUA_CONNECT_CONCURRENCY: 2,
    },
}));

jest.mock('@/utils/logger', () => ({
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

class FakeProvider implements OpcuaConnectionProvider {
    readonly connectionId: string;
    readonly name: string;
    status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'error' = 'disconnected';
    lastError?: string;
    started = false;
    stopped = false;
    terminatedKeys: string[] = [];
    private connectCbs: (() => void)[] = [];
    private reconnectCbs: (() => void)[] = [];

    constructor(config: ResolvedOpcuaConfig) {
        this.connectionId = config.id;
        this.name = config.name;
    }

    async start(): Promise<void> {
        this.started = true;
        this.status = 'connected';
        for (const cb of this.connectCbs) cb();
    }
    async stop(): Promise<void> {
        this.stopped = true;
        this.status = 'disconnected';
    }
    hasSession(): boolean { return this.status === 'connected'; }
    async readVariable(nodeId: string) { return { value: `value-of-${nodeId}`, quality: 'Good' }; }
    async readValues(nodeIds: string[]) { return nodeIds.map(() => 1); }
    async browse() { return []; }
    async createSubscription(): Promise<void> { /* no-op */ }
    async monitorNode(_k: string, _n: string, _s: number, _cb: (dv: OpcuaDataValue) => void): Promise<MonitorHandle> {
        return { id: 'm1', dispose: async () => undefined };
    }
    async terminateSubscription(key?: string): Promise<void> {
        if (key) this.terminatedKeys.push(key);
    }
    onConnect(cb: () => void): void { this.connectCbs.push(cb); }
    onReconnect(cb: () => void): void { this.reconnectCbs.push(cb); }
    fireReconnect(): void { for (const cb of this.reconnectCbs) cb(); }
}

class TestableManager extends OpcuaConnectionManager {
    createdProviders: FakeProvider[] = [];
    protected override createLocalProvider(config: ResolvedOpcuaConfig): OpcuaConnectionProvider {
        const provider = new FakeProvider(config);
        this.createdProviders.push(provider);
        return provider;
    }
}

const config = (id: string, alias: string): ResolvedOpcuaConfig => ({
    id,
    alias,
    name: `Server ${id}`,
    endpointUrl: `opc.tcp://${id}:4840`,
    securityMode: 'None',
    securityPolicy: 'None',
    authenticationMode: 'Anonymous',
    collectorId: null,
});

describe('OpcuaConnectionManager', () => {
    let manager: TestableManager;

    beforeEach(() => {
        manager = new TestableManager();
    });

    it('starts and registers connections resolvable by id and alias', async () => {
        await manager.startConnection(config('c1', 'kepserver'));
        expect(manager.resolveConnectionRef('c1')).toBe('c1');
        expect(manager.resolveConnectionRef('kepserver')).toBe('c1');
        expect(manager.getProvider('c1').hasSession()).toBe(true);
    });

    it('throws 503 for unknown providers', () => {
        expect(() => manager.getProvider('nope')).toThrow("OPC UA connection 'nope' is not running");
    });

    it('stopConnection removes provider and alias', async () => {
        await manager.startConnection(config('c1', 'kepserver'));
        await manager.stopConnection('c1');
        expect(manager.resolveConnectionRef('kepserver')).toBeNull();
        expect(() => manager.getProvider('c1')).toThrow();
    });

    it('enforces OPCUA_MAX_CONNECTIONS', async () => {
        await manager.startConnection(config('c1', 'a1'));
        await manager.startConnection(config('c2', 'a2'));
        await manager.startConnection(config('c3', 'a3'));
        await expect(manager.startConnection(config('c4', 'a4'))).rejects.toThrow('connection limit reached');
    });

    it('restarting the same id replaces the provider without hitting the limit', async () => {
        await manager.startConnection(config('c1', 'kepserver'));
        await manager.startConnection(config('c1', 'kepserver'));
        expect(manager.createdProviders).toHaveLength(2);
        expect(manager.createdProviders[0]!.stopped).toBe(true);
        expect(manager.health()).toHaveLength(1);
    });

    it('resolveTag: qualified tags route to the right connection; unqualified throw without a legacy default', async () => {
        await manager.startConnection(config('c1', 'kepserver'));
        expect(manager.resolveTag('opcua:kepserver:ns=2;s=X')).toEqual({ connectionId: 'c1', nodeId: 'ns=2;s=X' });
        expect(() => manager.resolveTag('opcua:ns=2;s=X')).toThrow('no legacy default connection');
        expect(manager.tryResolveTag('opcua:ns=2;s=X')).toBeNull();

        manager.setLegacyDefaultConnectionId('c1');
        expect(manager.resolveTag('opcua:ns=2;s=X')).toEqual({ connectionId: 'c1', nodeId: 'ns=2;s=X' });
    });

    it('readVariable resolves the tag and reads from the right provider', async () => {
        await manager.startConnection(config('c1', 'kepserver'));
        const result = await manager.readVariable('opcua:kepserver:ns=2;s=PV');
        expect(result.value).toBe('value-of-ns=2;s=PV');
    });

    it('onAnyConnect/onAnyReconnect fire with the connectionId', async () => {
        const connects: string[] = [];
        const reconnects: string[] = [];
        manager.onAnyConnect(id => connects.push(id));
        manager.onAnyReconnect(id => reconnects.push(id));

        await manager.startConnection(config('c1', 'a1'));
        await manager.startConnection(config('c2', 'a2'));
        expect(connects).toEqual(['c1', 'c2']);

        manager.createdProviders[1]!.fireReconnect();
        expect(reconnects).toEqual(['c2']);
    });

    it('terminateSubscriptionAll hits every provider', async () => {
        await manager.startConnection(config('c1', 'a1'));
        await manager.startConnection(config('c2', 'a2'));
        await manager.terminateSubscriptionAll('alerts');
        expect(manager.createdProviders[0]!.terminatedKeys).toEqual(['alerts']);
        expect(manager.createdProviders[1]!.terminatedKeys).toEqual(['alerts']);
    });

    it('health reports status, alias, and legacy-default flag', async () => {
        await manager.startConnection(config('c1', 'kepserver'));
        await manager.startConnection(config('c2', 'plc-2'));
        manager.setLegacyDefaultConnectionId('c2');

        const health = manager.health();
        expect(health).toHaveLength(2);
        const c2 = health.find(h => h.id === 'c2')!;
        expect(c2).toMatchObject({ alias: 'plc-2', status: 'connected', isLegacyDefault: true });
        expect(health.find(h => h.id === 'c1')!.isLegacyDefault).toBe(false);
    });

    it('startConnections starts everything through the concurrency limiter and tolerates failures', async () => {
        const bad = config('bad', 'bad-alias');
        const failing = new TestableManager();
        const origCreate = (failing as any).createLocalProvider.bind(failing);
        (failing as any).createLocalProvider = (cfg: ResolvedOpcuaConfig) => {
            const provider = origCreate(cfg);
            if (cfg.id === 'bad') {
                provider.start = async () => { throw new Error('boom'); };
            }
            return provider;
        };

        await failing.startConnections([config('c1', 'a1'), bad, config('c2', 'a2')]);
        expect(failing.findProvider('c1')?.hasSession()).toBe(true);
        expect(failing.findProvider('c2')?.hasSession()).toBe(true);
    });
});
