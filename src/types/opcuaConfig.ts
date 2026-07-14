/**
 * Type definitions for OPC UA configuration management
 */

export interface OpcuaConfiguration {
    id: string;
    name: string;
    /** Unique slug used in qualified tags: opcua:<alias>:<nodeId> */
    alias: string;
    endpointUrl: string;
    securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
    securityPolicy: 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256';
    authenticationMode: 'Anonymous' | 'Username';
    username?: string | undefined;
    encryptedPassword?: string | undefined;
    /** Many configurations may be enabled (connected) simultaneously. */
    enabled: boolean;
    /** Phase 2: non-null routes this connection through an edge collector. */
    collectorId?: string | null | undefined;
    /**
     * Reserved: per-connection certificate override for servers that demand a
     * unique ApplicationURI per client. Unused — all connections currently
     * share the one cert from getSharedCertificateManager().
     */
    certificateProfile?: string | null | undefined;
    /** @deprecated v1 field kept only for pre-migration files; use enabled. */
    isActive?: boolean | undefined;
    createdBy: string;
    createdAt: Date;
    lastTested?: Date | undefined;
    status: 'connected' | 'disconnected' | 'error' | 'untested' | 'failed';
    lastError?: string | undefined;
}

export interface OpcuaConfig {
    id?: string;
    name: string;
    alias?: string;
    endpointUrl: string;
    securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
    securityPolicy: 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256';
    authenticationMode: 'Anonymous' | 'Username';
    username?: string | undefined;
    password?: string | undefined;
}

export interface OpcuaTagInfo {
    nodeId: string;
    browseName: string;
    displayName: string;
    description?: string;
    dataType: string;
    nodeClass?: string;
    value?: any;
}
