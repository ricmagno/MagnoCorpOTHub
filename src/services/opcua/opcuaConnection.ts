import {
    OPCUAClient,
    MessageSecurityMode,
    SecurityPolicy,
    AttributeIds,
    ClientSession,
    UserTokenType,
    OPCUACertificateManager,
    ClientSubscription,
    ClientMonitoredItem,
    TimestampsToReturn,
    DataValue,
    browseAll,
    BrowseDirection,
} from 'node-opcua';
import type { MonitoringParametersOptions } from 'node-opcua';
import { v4 as uuidv4 } from 'uuid';
import { OpcuaConfig, OpcuaTagInfo } from '@/types/opcuaConfig';
import {
    ConnectionStats,
    ConnectionStatus,
    MonitorHandle,
    OpcuaConnectionProvider,
    OpcuaDataValue,
    OpcuaVariableReading,
} from '@/types/opcua';
import { logger } from '@/utils/logger';
import { createError } from '@/middleware/errorHandler';
import { RetryHandler } from '@/utils/retryHandler';
import { env, getDatabasePath } from '@/config/environment';

// One certificate manager (one PKI folder, one client certificate) shared by
// every local connection. Instantiating a manager per connection would race
// 50 PKI initializations against the same folder.
let sharedCertManager: OPCUACertificateManager | null = null;
export function getSharedCertificateManager(): OPCUACertificateManager {
    if (!sharedCertManager) {
        sharedCertManager = new OPCUACertificateManager({
            rootFolder: getDatabasePath('pki'),
            automaticallyAcceptUnknownCertificate: true,
        } as any);
    }
    return sharedCertManager;
}

// Supervised-reconnect backoff: 5s doubling to a 5min cap, with jitter so a
// site-wide network blip doesn't make every PLC connection retry in lockstep.
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
// A connect→drop cycle shorter than this counts toward the circuit breaker.
const RAPID_CYCLE_MS = 60_000;

/**
 * A single OPC UA server connection (KEPServerEX, a PLC, ...).
 *
 * Extracted from the former opcuaService singleton so many connections can
 * run side by side under opcuaConnectionManager. Unlike the singleton, a
 * failed connect does not stay dead until an admin re-activates: start()
 * supervises the connection with capped exponential backoff until stop().
 */
export class OpcuaConnection implements OpcuaConnectionProvider {
    readonly connectionId: string;
    readonly name: string;

    private client: OPCUAClient | null = null;
    private session: ClientSession | null = null;
    private readonly config: OpcuaConfig;
    private readonly certManager: OPCUACertificateManager;
    private readonly supervise: boolean;

    private _status: ConnectionStatus = 'disconnected';
    private _lastError: string | undefined;
    private stopped = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempt = 0;
    // Circuit breaker: a PLC that connects and drops within RAPID_CYCLE_MS
    // repeatedly would otherwise storm at minimum backoff forever (each
    // success resets the backoff). After enough rapid cycles, quarantine.
    private connectedAt: number | null = null;
    private rapidCycles = 0;
    private lastDataTimestamp: string | undefined;

    // Keyed, not a single slot: multiple independent consumers (alert
    // evaluation, TEVE ingestion, ...) each own their own subscription on
    // this connection. A single shared slot meant the second consumer's
    // createSubscription() call silently terminated the first's.
    private subscriptions: Map<string, ClientSubscription> = new Map();
    private monitoredItems: Map<string, ClientMonitoredItem> = new Map();
    private connectCallbacks: (() => void)[] = [];
    private reconnectCallbacks: (() => void)[] = [];

    /**
     * @param supervise when false (test-connection probes), a failed connect
     *   rejects instead of scheduling background retries.
     */
    constructor(config: OpcuaConfig, certManager: OPCUACertificateManager, supervise = true) {
        this.config = config;
        this.certManager = certManager;
        this.supervise = supervise;
        this.connectionId = config.id || uuidv4();
        this.name = config.name;
    }

    get status(): ConnectionStatus {
        return this._status;
    }

    get lastError(): string | undefined {
        return this._lastError;
    }

    hasSession(): boolean {
        return this.session !== null;
    }

    // Registers an additional callback; does not replace previously registered ones.
    onConnect(cb: () => void): void {
        this.connectCallbacks.push(cb);
    }

    onReconnect(cb: () => void): void {
        this.reconnectCallbacks.push(cb);
    }

    hasSubscription(key: string): boolean {
        return this.subscriptions.has(key);
    }

    stats(): ConnectionStats {
        return {
            subscriptionCount: this.subscriptions.size,
            monitoredItemCount: this.monitoredItems.size,
            lastDataTimestamp: this.lastDataTimestamp,
        };
    }

    /**
     * Connect and keep the connection alive until stop().
     * Resolves once the first connect attempt cycle finishes — possibly with
     * status 'reconnecting' if the server is currently unreachable (supervised
     * mode). Rejects only in unsupervised mode.
     */
    async start(): Promise<void> {
        this.stopped = false;
        try {
            await this.connectOnce();
        } catch (error: any) {
            if (!this.supervise) {
                throw error;
            }
            this.scheduleReconnect();
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        await this.disconnect();
        this._status = 'disconnected';
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) return;
        this._status = 'reconnecting';

        // Circuit breaker bookkeeping: was the last session short-lived?
        if (this.connectedAt !== null) {
            if (Date.now() - this.connectedAt < RAPID_CYCLE_MS) {
                this.rapidCycles++;
            } else {
                this.rapidCycles = 0;
            }
            this.connectedAt = null;
        }

        let delay: number;
        if (this.rapidCycles >= env.OPCUA_QUARANTINE_AFTER_CYCLES) {
            delay = env.OPCUA_QUARANTINE_MS + Math.random() * 30_000;
            this._lastError = `Quarantined after ${this.rapidCycles} rapid reconnect cycles — next attempt in ${Math.round(delay / 60_000)}min`;
            logger.warn(`OPC UA '${this.name}': ${this._lastError}`);
        } else {
            const exp = Math.min(
                RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
                RECONNECT_MAX_DELAY_MS
            );
            delay = exp / 2 + Math.random() * (exp / 2); // jitter in [exp/2, exp]
        }
        this.reconnectAttempt++;
        logger.info(
            `OPC UA '${this.name}': scheduling reconnect attempt ${this.reconnectAttempt} in ${Math.round(delay / 1000)}s`
        );
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectOnce()
                .then(() => {
                    for (const cb of this.reconnectCallbacks) cb();
                })
                .catch(() => this.scheduleReconnect());
        }, delay);
        // Do not hold the process open just to retry a PLC connection.
        this.reconnectTimer.unref?.();
    }

    private async connectOnce(): Promise<void> {
        const config = this.config;
        try {
            this._status = 'connecting';

            // Set up client with a robust connection strategy and certificate management
            this.client = OPCUAClient.create({
                endpointMustExist: false,
                securityMode: MessageSecurityMode[config.securityMode as keyof typeof MessageSecurityMode] || MessageSecurityMode.None,
                securityPolicy: SecurityPolicy[config.securityPolicy as keyof typeof SecurityPolicy] || SecurityPolicy.None,
                connectionStrategy: {
                    maxRetry: 5, // More retries for stability
                    initialDelay: 2000,
                    maxDelay: 10000,
                },
                requestedSessionTimeout: 60000, // More generous session timeout
                keepSessionAlive: true,
                clientCertificateManager: this.certManager,
            });

            this.client.on('connection_reestablished', () => {
                // node-opcua recovered on its own — count the cycle for the
                // circuit breaker but let its internal strategy own the session.
                if (this.connectedAt !== null && Date.now() - this.connectedAt < RAPID_CYCLE_MS) {
                    this.rapidCycles++;
                } else {
                    this.rapidCycles = 0;
                }
                this.connectedAt = Date.now();
                this._status = 'connected';
                for (const cb of this.reconnectCallbacks) cb();
            });
            this.client.on('connection_lost', () => {
                logger.warn(`OPC UA '${this.name}': connection lost`);
                if (!this.stopped) this._status = 'reconnecting';
            });
            // Fires when node-opcua's own connectionStrategy gives up for good;
            // without this hook a dropped PLC would stay dead until an admin
            // toggled it. Hand the connection back to our supervised backoff.
            this.client.on('close', () => {
                if (this.stopped || this.reconnectTimer) return;
                if (this._status === 'connected' || this._status === 'reconnecting') {
                    logger.warn(`OPC UA '${this.name}': client closed — entering supervised reconnect`);
                    this.session = null;
                    if (this.supervise) this.scheduleReconnect();
                }
            });

            logger.info(`Attempting to connect to OPC UA server '${this.name}': ${config.endpointUrl}`, {
                securityMode: config.securityMode,
                securityPolicy: config.securityPolicy,
                authenticationMode: config.authenticationMode
            });

            // Use RetryHandler for the connection and session creation
            await RetryHandler.executeWithRetry(
                async () => {
                    if (!this.client) {
                        throw new Error('OPC UA client is not initialized');
                    }

                    // Advanced Discovery before connecting
                    try {
                        logger.info(`Discovering server endpoints: ${config.endpointUrl}`);
                        const endpoints = await this.client.getEndpoints({ endpointUrl: config.endpointUrl });

                        logger.info(`Server discovered with ${endpoints.length} endpoints`);
                        endpoints.forEach((ep, i) => {
                            const policies = ep.userIdentityTokens?.map(p => `${p.policyId} (${UserTokenType[p.tokenType as any]})`).join(', ');
                            logger.info(`Endpoint ${i + 1}:`, {
                                endpointUrl: ep.endpointUrl,
                                securityMode: MessageSecurityMode[ep.securityMode],
                                securityPolicy: ep.securityPolicyUri,
                                userPolicies: policies
                            });
                        });

                        // Check if current config matches any discovered endpoint
                        const targetSecurityMode = (MessageSecurityMode as any)[config.securityMode];
                        const targetSecurityPolicy = (SecurityPolicy as any)[config.securityPolicy];

                        const matchingEndpoint = endpoints.find(ep =>
                            ep.securityMode === targetSecurityMode &&
                            ep.securityPolicyUri === targetSecurityPolicy
                        );

                        if (!matchingEndpoint) {
                            logger.warn('WARNING: No exact matching endpoint found for current configuration in server discovery data.');
                        } else {
                            logger.info('Matching server endpoint found for current configuration.');
                            const supportsUsername = matchingEndpoint.userIdentityTokens?.some(p => p.tokenType === UserTokenType.UserName);
                            if (!supportsUsername && config.authenticationMode === 'Username') {
                                logger.error('CRITICAL: The selected endpoint DOES NOT appear to support Username/Password authentication according to server discovery data!');
                            }
                        }
                    } catch (discoveryError: any) {
                        logger.warn(`Endpoint discovery failed: ${discoveryError.message}. Proceeding with direct connection...`);
                    }

                    // Attempt connection
                    await this.client.connect(config.endpointUrl);
                    logger.info(`Connected to OPC UA server '${this.name}': ${config.endpointUrl}`);

                    // Attempt session creation
                    const isUsernameAuth = config.authenticationMode === 'Username';

                    logger.info(`Creating OPC UA session with mode: ${config.authenticationMode}`, {
                        hasUsername: !!config.username,
                        hasPassword: !!config.password,
                        securityMode: config.securityMode,
                        securityPolicy: config.securityPolicy
                    });

                    const userIdentity: any = isUsernameAuth
                        ? {
                            type: UserTokenType.UserName,
                            userName: config.username || '',
                            password: config.password || ''
                        }
                        : { type: UserTokenType.Anonymous };

                    this.session = await this.client.createSession(userIdentity);
                    logger.info(`OPC UA session created for '${this.name}'`);
                },
                {
                    maxAttempts: 3,
                    baseDelay: 2000,
                    retryCondition: (error: Error) => {
                        const message = error.message.toLowerCase();
                        // Do NOT retry on Access Denied as it's likely a config/auth issue
                        if (message.includes('accessdenied') || message.includes('denied')) {
                            return false;
                        }
                        return message.includes('premature disconnection') ||
                            message.includes('timeout') ||
                            message.includes('connection') ||
                            message.includes('socket') ||
                            message.includes('disconnected');
                    }
                },
                `OPC UA Connection '${this.name}'`
            );

            this._status = 'connected';
            this._lastError = undefined;
            this.reconnectAttempt = 0;
            this.connectedAt = Date.now();
            for (const cb of this.connectCallbacks) cb();
        } catch (error: any) {
            this._status = 'error';
            this._lastError = error.message || 'Unknown error';
            const errorDetails = {
                message: error.message,
                code: error.code,
                endpointUrl: config.endpointUrl,
            };
            logger.error(`Failed to connect to OPC UA server '${this.name}' after retries:`, errorDetails);

            // Provide helpful hint for BadUserAccessDenied
            if (error.message?.includes('BadUserAccessDenied')) {
                logger.error('CRITICAL: ACCESS DENIED. Possible reasons:');
                logger.error('1. Wrong username/password (double check case sensitivity)');
                logger.error('2. Username format: try "DOMAIN\\username" or ".\\username" if using Windows-based server');
                logger.error('3. Account locked or disabled on OPC UA server');
                logger.error('4. Server requires encryption for username/password login, but current mode is None');
                logger.error('5. Client certificate is NOT trusted on the server (check server trust list)');
            }

            // Cleanup on failure
            if (this.client) {
                try {
                    await this.client.disconnect();
                } catch (e) {
                    logger.warn('Error during emergency OPC UA disconnect:', e);
                }
                this.client = null;
            }
            this.session = null;

            throw createError(`Failed to connect to OPC UA server: ${error.message || 'Unknown error'}`, 500);
        }
    }

    private async disconnect(): Promise<void> {
        try {
            await this.terminateSubscription();
            if (this.session) {
                await this.session.close();
                this.session = null;
            }
            if (this.client) {
                await this.client.disconnect();
                this.client = null;
            }
            logger.info(`Disconnected from OPC UA server '${this.name}'`);
        } catch (error) {
            logger.error(`Error during OPC UA disconnection ('${this.name}'):`, error);
        }
    }

    async createSubscription(key: string, publishingIntervalMs = 1000): Promise<void> {
        if (!this.session) {
            throw new Error(`No active OPC UA session on connection '${this.name}'`);
        }
        await this.terminateSubscription(key);
        const subscription = ClientSubscription.create(this.session, {
            requestedPublishingInterval: publishingIntervalMs,
            requestedLifetimeCount: 100,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 1000,
            publishingEnabled: true,
            priority: 1,
        });
        await new Promise<void>((resolve) => subscription.on('started', () => resolve()));
        this.subscriptions.set(key, subscription);
        logger.info(`OPC UA subscription '${key}' started on '${this.name}' (publishingInterval=${publishingIntervalMs}ms)`);
    }

    async monitorNode(
        key: string,
        nodeId: string,
        samplingIntervalMs: number,
        cb: (dv: OpcuaDataValue) => void
    ): Promise<MonitorHandle> {
        const subscription = this.subscriptions.get(key);
        if (!subscription) {
            throw new Error(`No active OPC UA subscription '${key}' on '${this.name}' — call createSubscription('${key}') first`);
        }
        const item = ClientMonitoredItem.create(
            subscription,
            { nodeId, attributeId: AttributeIds.Value },
            { samplingInterval: samplingIntervalMs, discardOldest: true, queueSize: 10 } as MonitoringParametersOptions,
            TimestampsToReturn.Both
        );
        item.on('changed', (dv: DataValue) => {
            const value = toOpcuaDataValue(dv);
            this.lastDataTimestamp = value.sourceTimestamp ?? value.serverTimestamp ?? new Date().toISOString();
            cb(value);
        });

        const id = uuidv4();
        this.monitoredItems.set(id, item);
        const monitoredItems = this.monitoredItems;
        return {
            id,
            async dispose(): Promise<void> {
                monitoredItems.delete(id);
                try {
                    await item.terminate();
                } catch (e) {
                    logger.warn(`Error terminating monitored item ${nodeId}:`, e);
                }
            },
        };
    }

    /** Terminates one subscription by key, or all of them if no key is given. */
    async terminateSubscription(key?: string): Promise<void> {
        const keys = key ? [key] : Array.from(this.subscriptions.keys());
        for (const k of keys) {
            const subscription = this.subscriptions.get(k);
            if (!subscription) continue;
            try {
                await subscription.terminate();
            } catch (e) {
                logger.warn(`Error terminating OPC UA subscription '${k}' on '${this.name}':`, e);
            }
            this.subscriptions.delete(k);
        }
    }

    /**
     * Uses node-opcua's browseAll (not session.browse directly) — real B&R PLC
     * address spaces flatten hundreds of function-block instances into one folder
     * (1000+ children), and a raw session.browse() silently drops everything past
     * the server's own per-request page limit with no continuation-point handling.
     * browseAll loops browseNext() until the continuation point is exhausted.
     */
    async browse(nodeId: string = 'RootFolder'): Promise<OpcuaTagInfo[]> {
        if (!this.session) {
            throw createError(`No active OPC UA session on connection '${this.name}'`, 503);
        }

        try {
            // browseAll's bare-string coercion only sets {nodeId} — unlike
            // session.browse(string)'s own internal coercion, it leaves
            // referenceTypeId/resultMask/etc. unset, which some servers (confirmed:
            // a real B&R PLC) interpret as "return nothing" rather than "use
            // defaults". Pass the exact same defaults session.browse(string) used.
            const browseResult = await browseAll(this.session, {
                nodeId,
                browseDirection: BrowseDirection.Forward,
                includeSubtypes: true,
                nodeClassMask: 0,
                referenceTypeId: 'HierarchicalReferences',
                resultMask: 63,
            });
            const tags: OpcuaTagInfo[] = [];

            if (browseResult.references) {
                for (const ref of browseResult.references) {
                    // We only care about objects and variables
                    if (ref.nodeClass === 1 || ref.nodeClass === 2) {
                        tags.push({
                            nodeId: ref.nodeId.toString(),
                            browseName: ref.browseName.toString(),
                            displayName: ref.displayName.text?.toString() || '',
                            nodeClass: ref.nodeClass === 2 ? 'Variable' : 'Object',
                            dataType: 'unknown', // Will be updated if read
                        });
                    }
                }
            }
            return tags;
        } catch (error) {
            logger.error(`Error browsing OPC UA node ${nodeId} on '${this.name}':`, error);
            throw createError('Failed to browse OPC UA server', 500);
        }
    }

    async readVariable(nodeId: string): Promise<OpcuaVariableReading> {
        if (!this.session) {
            throw createError(`No active OPC UA session on connection '${this.name}'`, 503);
        }

        try {
            const dataValues = await this.session.read([
                { nodeId, attributeId: AttributeIds.Value },
                { nodeId, attributeId: AttributeIds.Description },
                { nodeId, attributeId: AttributeIds.DisplayName },
            ]);

            const valueData = dataValues[0];
            const descriptionData = dataValues[1];
            const displayNameData = dataValues[2];

            return {
                value: valueData?.value?.value,
                quality: valueData?.statusCode?.name === 'Good' ? 'Good' : 'Bad',
                description: descriptionData?.value?.value?.text?.toString() || '',
                displayName: displayNameData?.value?.value?.text?.toString() || ''
            };
        } catch (error) {
            logger.error(`Error reading OPC UA variable ${nodeId} on '${this.name}':`, error);
            throw createError('Failed to read OPC UA variable', 500);
        }
    }

    async readValues(nodeIds: string[]): Promise<any[]> {
        if (!this.session) {
            throw createError(`No active OPC UA session on connection '${this.name}'`, 503);
        }

        if (!nodeIds || nodeIds.length === 0) {
            return [];
        }

        try {
            const nodesToRead = nodeIds.map(nodeId => ({
                nodeId,
                attributeId: AttributeIds.Value,
            }));

            const dataValues = await this.session.read(nodesToRead);

            return dataValues.map(dv => {
                if (dv.statusCode?.name !== 'Good' && dv.statusCode?.name !== 'Uncertain') {
                    return null;
                }
                return dv.value?.value;
            });
        } catch (error) {
            logger.error(`Error reading OPC UA variables batch on '${this.name}':`, error);
            throw createError('Failed to read OPC UA variables', 500);
        }
    }
}

function toOpcuaDataValue(dv: DataValue): OpcuaDataValue {
    return {
        value: dv.value?.value,
        statusName: dv.statusCode?.name || 'Bad',
        sourceTimestamp: dv.sourceTimestamp ? dv.sourceTimestamp.toISOString() : undefined,
        serverTimestamp: dv.serverTimestamp ? dv.serverTimestamp.toISOString() : undefined,
    };
}
