import { OPCUACertificateManager } from 'node-opcua';
import { OpcuaConfig, OpcuaTagInfo } from '@/types/opcuaConfig';
import {
    ConnectionStatus,
    OpcuaConnectionProvider,
    OpcuaVariableReading,
} from '@/types/opcua';
import { OpcuaConnection, getSharedCertificateManager } from './opcuaConnection';
import {
    NO_CONNECTION_MESSAGE,
    TagRegistryView,
    parseOpcuaTag,
} from './tagResolver';
import { logger } from '@/utils/logger';
import { createError } from '@/middleware/errorHandler';
import { env } from '@/config/environment';

/** Config as handed to the manager: decrypted password plus registry fields. */
export interface ResolvedOpcuaConfig extends OpcuaConfig {
    id: string;
    alias: string;
    /** Phase 2: non-null routes the connection through an edge collector. */
    collectorId?: string | null;
}

export interface ConnectionHealth {
    id: string;
    name: string;
    alias: string;
    status: ConnectionStatus;
    lastError?: string | undefined;
    isLegacyDefault: boolean;
    subscriptionCount?: number;
    monitoredItemCount?: number;
    lastDataTimestamp?: string | undefined;
}

/**
 * Registry of live OPC UA connections (KEPServerEX + PLCs), each an
 * OpcuaConnectionProvider. Consumers resolve `opcua:` tags and reach the
 * right provider exclusively through this manager; the legacy unqualified-tag
 * fallback is applied here (via tagResolver) and is disabled until an admin
 * designates a legacy-default connection.
 */
export class OpcuaConnectionManager implements TagRegistryView {
    private providers = new Map<string, OpcuaConnectionProvider>();
    private aliases = new Map<string, string>(); // alias -> connectionId
    private legacyDefaultConnectionId: string | null = null;
    private anyConnectCallbacks: ((connectionId: string) => void)[] = [];
    private anyReconnectCallbacks: ((connectionId: string) => void)[] = [];

    // --- TagRegistryView ---

    resolveConnectionRef(idOrAlias: string): string | null {
        if (this.providers.has(idOrAlias)) return idOrAlias;
        return this.aliases.get(idOrAlias) ?? null;
    }

    getLegacyDefaultConnectionId(): string | null {
        return this.legacyDefaultConnectionId;
    }

    setLegacyDefaultConnectionId(connectionId: string | null): void {
        this.legacyDefaultConnectionId = connectionId;
    }

    // --- Tag resolution ---

    /** Throws createError(400) when an unqualified tag has no legacy default. */
    resolveTag(tag: string): { connectionId: string; nodeId: string } {
        const parsed = parseOpcuaTag(tag, this);
        if ('error' in parsed) {
            throw createError(`${NO_CONNECTION_MESSAGE}: ${tag}`, 400);
        }
        return parsed;
    }

    /** Non-throwing variant for callers that degrade to Bad quality. */
    tryResolveTag(tag: string): { connectionId: string; nodeId: string } | null {
        const parsed = parseOpcuaTag(tag, this);
        return 'error' in parsed ? null : parsed;
    }

    // --- Providers ---

    getProvider(connectionId: string): OpcuaConnectionProvider {
        const provider = this.providers.get(connectionId);
        if (!provider) {
            throw createError(`OPC UA connection '${connectionId}' is not running`, 503);
        }
        return provider;
    }

    findProvider(connectionId: string): OpcuaConnectionProvider | null {
        return this.providers.get(connectionId) ?? null;
    }

    listProviders(): OpcuaConnectionProvider[] {
        return Array.from(this.providers.values());
    }

    async startConnection(config: ResolvedOpcuaConfig): Promise<void> {
        if (this.providers.has(config.id)) {
            await this.stopConnection(config.id);
        }
        if (this.providers.size >= env.OPCUA_MAX_CONNECTIONS) {
            throw createError(
                `OPC UA connection limit reached (OPCUA_MAX_CONNECTIONS=${env.OPCUA_MAX_CONNECTIONS})`,
                400
            );
        }

        // Phase 2 will dispatch RemoteOpcuaConnection here when collectorId is set.
        if (config.collectorId) {
            throw createError('Collector-hosted OPC UA connections are not supported yet', 501);
        }
        const provider = this.createLocalProvider(config, getSharedCertificateManager());

        provider.onConnect(() => {
            for (const cb of this.anyConnectCallbacks) cb(config.id);
        });
        provider.onReconnect(() => {
            for (const cb of this.anyReconnectCallbacks) cb(config.id);
        });

        this.providers.set(config.id, provider);
        this.aliases.set(config.alias, config.id);
        await provider.start();
    }

    /** Seam for tests and Phase 2 dispatch. */
    protected createLocalProvider(
        config: ResolvedOpcuaConfig,
        certManager: OPCUACertificateManager
    ): OpcuaConnectionProvider {
        return new OpcuaConnection(config, certManager);
    }

    async stopConnection(connectionId: string): Promise<void> {
        const provider = this.providers.get(connectionId);
        if (!provider) return;
        this.providers.delete(connectionId);
        for (const [alias, id] of this.aliases) {
            if (id === connectionId) this.aliases.delete(alias);
        }
        await provider.stop();
    }

    async stopAll(): Promise<void> {
        const ids = Array.from(this.providers.keys());
        await Promise.all(ids.map(id => this.stopConnection(id)));
    }

    /**
     * Start many connections with bounded concurrency and jitter. 50 parallel
     * SignAndEncrypt handshakes is a CPU thundering herd; individual failures
     * are logged and left to each connection's supervised reconnect.
     */
    async startConnections(configs: ResolvedOpcuaConfig[]): Promise<void> {
        const queue = [...configs];
        const workers = Array.from(
            { length: Math.min(env.OPCUA_CONNECT_CONCURRENCY, queue.length) },
            async () => {
                for (;;) {
                    const config = queue.shift();
                    if (!config) return;
                    await new Promise(r => setTimeout(r, Math.random() * 500));
                    try {
                        await this.startConnection(config);
                    } catch (error: any) {
                        logger.error(`Failed to start OPC UA connection '${config.name}':`, error.message);
                    }
                }
            }
        );
        await Promise.all(workers);
    }

    // --- Tag-form conveniences (dataRetrieval / dataFlowService) ---

    async readVariable(tag: string): Promise<OpcuaVariableReading> {
        const { connectionId, nodeId } = this.resolveTag(tag);
        return this.getProvider(connectionId).readVariable(nodeId);
    }

    async browse(connectionId: string, nodeId?: string): Promise<OpcuaTagInfo[]> {
        return this.getProvider(connectionId).browse(nodeId);
    }

    // --- Subscription conveniences (alertEval / teveIngest) ---

    async terminateSubscriptionAll(key: string): Promise<void> {
        for (const provider of this.providers.values()) {
            try {
                await provider.terminateSubscription(key);
            } catch (error) {
                logger.warn(`Failed terminating subscription '${key}' on '${provider.name}':`, error);
            }
        }
    }

    onAnyConnect(cb: (connectionId: string) => void): void {
        this.anyConnectCallbacks.push(cb);
    }

    onAnyReconnect(cb: (connectionId: string) => void): void {
        this.anyReconnectCallbacks.push(cb);
    }

    // --- Health ---

    health(): ConnectionHealth[] {
        return Array.from(this.providers.entries()).map(([id, p]) => {
            const alias =
                Array.from(this.aliases.entries()).find(([, cid]) => cid === id)?.[0] ?? '';
            const stats = p.stats?.();
            return {
                id,
                name: p.name,
                alias,
                status: p.status,
                lastError: p.lastError,
                isLegacyDefault: id === this.legacyDefaultConnectionId,
                ...(stats ?? {}),
            };
        });
    }

    hasAnySession(): boolean {
        return Array.from(this.providers.values()).some(p => p.hasSession());
    }
}

export const opcuaManager = new OpcuaConnectionManager();
