/**
 * Transport-neutral OPC UA types shared by every connection provider.
 *
 * These types deliberately contain no node-opcua classes: a provider may be a
 * local node-opcua client (OpcuaConnection) or, later, a remote connection
 * proxied over a collector's socket link (Phase 2) — so everything crossing
 * this interface must survive JSON serialization.
 */

import { OpcuaTagInfo } from './opcuaConfig';

export interface OpcuaDataValue {
    value: unknown;
    /** StatusCode.name from the server: 'Good' | 'Uncertain' | 'Bad...' */
    statusName: string;
    /** ISO 8601 strings — serializable across a socket boundary */
    sourceTimestamp?: string | undefined;
    serverTimestamp?: string | undefined;
}

export type ConnectionStatus =
    | 'connected'
    | 'connecting'
    | 'reconnecting'
    | 'disconnected'
    | 'error';

/** Handle for a monitored item; dispose() stops monitoring that node. */
export interface MonitorHandle {
    readonly id: string;
    dispose(): Promise<void>;
}

export interface ConnectionStats {
    subscriptionCount: number;
    monitoredItemCount: number;
    lastDataTimestamp?: string | undefined;
}

export interface OpcuaVariableReading {
    value: any;
    quality: string;
    description?: string;
    displayName?: string;
}

/**
 * The uniform interface all OPC UA consumers program against.
 * Local (node-opcua) and remote (collector-proxied) connections both
 * implement it, so consumers never know where a connection lives.
 */
export interface OpcuaConnectionProvider {
    readonly connectionId: string;
    readonly name: string;
    readonly status: ConnectionStatus;
    readonly lastError?: string | undefined;

    /** Connect and keep supervising reconnects until stop(). Never rejects permanently. */
    start(): Promise<void>;
    stop(): Promise<void>;
    hasSession(): boolean;

    readVariable(nodeId: string): Promise<OpcuaVariableReading>;
    readValues(nodeIds: string[]): Promise<any[]>;
    browse(nodeId?: string): Promise<OpcuaTagInfo[]>;

    createSubscription(key: string, publishingIntervalMs?: number): Promise<void>;
    monitorNode(
        key: string,
        nodeId: string,
        samplingIntervalMs: number,
        cb: (dv: OpcuaDataValue) => void
    ): Promise<MonitorHandle>;
    terminateSubscription(key?: string): Promise<void>;

    onConnect(cb: () => void): void;
    onReconnect(cb: () => void): void;

    /** Optional live counters for health reporting. */
    stats?(): ConnectionStats;
}
