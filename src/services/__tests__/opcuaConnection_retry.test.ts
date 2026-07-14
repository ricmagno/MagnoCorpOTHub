import { OpcuaConnection } from '../opcua/opcuaConnection';
import { OPCUAClient } from 'node-opcua';
import { OpcuaConfig } from '@/types/opcuaConfig';

// Mock node-opcua
jest.mock('node-opcua', () => ({
    OPCUAClient: {
        create: jest.fn().mockImplementation(() => ({
            getEndpoints: jest.fn().mockResolvedValue([]),
            connect: jest.fn(),
            createSession: jest.fn(),
            disconnect: jest.fn(),
        })),
    },
    OPCUACertificateManager: jest.fn().mockImplementation(() => ({})),
    MessageSecurityMode: {
        None: 0,
        Sign: 1,
        SignAndEncrypt: 2,
    },
    SecurityPolicy: {
        None: 'http://opcfoundation.org/UA/SecurityPolicy#None',
    },
    UserTokenType: {
        Anonymous: 0,
        UserName: 1,
        Certificate: 2,
        IssuedToken: 3,
    },
    AttributeIds: {
        Value: 13,
        Description: 24,
        DisplayName: 4
    },
    TimestampsToReturn: {
        Both: 2,
    },
}));

jest.mock('@/config/environment', () => ({
    getDatabasePath: jest.fn().mockReturnValue('/mock/path/pki'),
    env: {
        OPCUA_MAX_CONNECTIONS: 64,
        OPCUA_CONNECT_CONCURRENCY: 5,
        OPCUA_QUARANTINE_AFTER_CYCLES: 3,
        OPCUA_QUARANTINE_MS: 900_000,
    },
}));

// Mock logger
jest.mock('@/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    },
    dbLogger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }
}));

describe('OpcuaConnection Retry Logic', () => {
    let mockClient: any;
    let mockSession: any;
    const mockCertManager = {} as any;

    const testConfig: OpcuaConfig = {
        id: 'test-id',
        name: 'Test Server',
        endpointUrl: 'opc.tcp://localhost:4840',
        securityMode: 'None',
        securityPolicy: 'None',
        authenticationMode: 'Anonymous'
    };

    const newConnection = (supervise = false) =>
        new OpcuaConnection(testConfig, mockCertManager, supervise);

    beforeEach(() => {
        jest.clearAllMocks();

        mockSession = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        mockClient = {
            getEndpoints: jest.fn().mockResolvedValue([]),
            connect: jest.fn(),
            createSession: jest.fn(),
            disconnect: jest.fn().mockResolvedValue(undefined),
            // Real OPCUAClient instances are EventEmitters; OpcuaConnection always wires
            // up 'connection_reestablished'/'connection_lost' listeners on connect.
            on: jest.fn(),
        };

        (OPCUAClient.create as jest.Mock).mockReturnValue(mockClient);
    });

    it('should retry on "premature disconnection" error and eventually succeed', async () => {
        // Fail twice with premature disconnection, succeed on 3rd attempt
        mockClient.connect
            .mockRejectedValueOnce(new Error('premature disconnection 4'))
            .mockRejectedValueOnce(new Error('premature disconnection 4'))
            .mockResolvedValueOnce(undefined);

        mockClient.createSession.mockResolvedValue(mockSession);

        const connection = newConnection();
        await connection.start();

        expect(mockClient.connect).toHaveBeenCalledTimes(3);
        expect(mockClient.createSession).toHaveBeenCalledTimes(1);
        expect(connection.status).toBe('connected');
        expect(connection.hasSession()).toBe(true);
    });

    it('should fail after maximum retries (unsupervised)', async () => {
        // Always fail with premature disconnection
        mockClient.connect.mockRejectedValue(new Error('premature disconnection 4'));

        const connection = newConnection();
        await expect(connection.start()).rejects.toThrow('Failed to connect to OPC UA server');

        // RetryHandler is configured for 3 attempts in opcuaConnection.ts
        expect(mockClient.connect).toHaveBeenCalledTimes(3);
        expect(connection.status).toBe('error');
        expect(connection.lastError).toContain('premature disconnection');
    });

    it('should not retry on non-retryable errors', async () => {
        // Fail with an error that shouldn't be retried (not in the list)
        mockClient.connect.mockRejectedValue(new Error('Invalid certificate'));

        const connection = newConnection();
        await expect(connection.start()).rejects.toThrow('Failed to connect to OPC UA server');

        // Should only be called once
        expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it('quarantines after repeated rapid connect→drop cycles (circuit breaker)', async () => {
        jest.useFakeTimers();
        try {
            mockClient.connect.mockResolvedValue(undefined);
            mockClient.createSession.mockResolvedValue(mockSession);

            const connection = newConnection(true);
            await connection.start();
            expect(connection.status).toBe('connected');

            // The client's 'close' handler hands a dead client back to supervision.
            const closeHandler = mockClient.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
            expect(closeHandler).toBeDefined();

            // 3 rapid connect→drop cycles (OPCUA_QUARANTINE_AFTER_CYCLES mocked to 3):
            // each drop happens "immediately" (< 60s of uptime), each reconnect succeeds.
            for (let i = 0; i < 3; i++) {
                closeHandler();
                expect(connection.status).toBe('reconnecting');
                // Normal supervised backoff is < 30s at this attempt count.
                await jest.advanceTimersByTimeAsync(60_000);
            }

            // Next drop trips the breaker: the reconnect delay jumps to the
            // quarantine window, so a minute of waiting is no longer enough.
            closeHandler();
            expect(connection.lastError).toContain('Quarantined');
            await jest.advanceTimersByTimeAsync(60_000);
            expect(connection.status).toBe('reconnecting');

            // After the full quarantine (15min + up to 30s jitter) it retries and recovers.
            await jest.advanceTimersByTimeAsync(931_000);
            expect(connection.status).toBe('connected');

            await connection.stop();
        } finally {
            jest.useRealTimers();
        }
    });

    it('should keep supervising after retry exhaustion instead of dying (supervised)', async () => {
        jest.useFakeTimers();
        try {
            mockClient.connect.mockRejectedValue(new Error('premature disconnection 4'));

            const connection = newConnection(true);
            // Supervised start resolves (never rejects) and schedules a background retry.
            const startPromise = connection.start();
            // Drain the RetryHandler's internal backoff sleeps (~2s + ~4s with jitter)
            // without also chasing the never-ending supervised reconnect timer.
            await jest.advanceTimersByTimeAsync(10_000);
            await startPromise;

            // Retry exhaustion did not kill the connection: start() resolved and
            // supervision is either waiting to retry or already mid-retry.
            expect(['reconnecting', 'connecting']).toContain(connection.status);
            expect(mockClient.connect.mock.calls.length).toBeGreaterThanOrEqual(3);

            // Let the supervised backoff fire once more and succeed this time.
            mockClient.connect.mockResolvedValue(undefined);
            mockClient.createSession.mockResolvedValue(mockSession);
            const reconnected = new Promise<void>(resolve => connection.onReconnect(resolve));
            // Generous advance: covers in-flight RetryHandler sleeps plus the
            // next supervised delay (jittered, capped).
            await jest.advanceTimersByTimeAsync(30_000);
            await reconnected;

            expect(connection.status).toBe('connected');
            await connection.stop();
        } finally {
            jest.useRealTimers();
        }
    });
});
