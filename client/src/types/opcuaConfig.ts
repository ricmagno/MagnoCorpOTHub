export interface OpcuaConfig {
    id?: string;
    name: string;
    /** Unique slug used in qualified tags: opcua:<alias>:<nodeId>. Generated from name if omitted. */
    alias?: string;
    endpointUrl: string;
    securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
    securityPolicy: 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256';
    authenticationMode: 'Anonymous' | 'Username';
    username?: string;
    password?: string;
}

export interface OpcuaConfiguration extends OpcuaConfig {
    id: string;
    alias: string;
    /** Many connections may be enabled (connected) simultaneously. */
    enabled: boolean;
    /** True when this connection is the designated target for unqualified legacy tags. */
    isLegacyDefault: boolean;
    /** Live connection state reported by the server's connection manager. */
    liveStatus: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'error';
    createdBy: string;
    createdAt: Date;
    status: 'untested' | 'connected' | 'failed' | 'disconnected' | 'error';
    lastError?: string;
}

export interface OpcuaConnectionHealth {
    id: string;
    name: string;
    alias: string;
    status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'error';
    lastError?: string;
    isLegacyDefault: boolean;
}

export interface OpcuaCapacity {
    /** Active connection slots currently held (providers.size on the server). */
    used: number;
    /** OPCUA_MAX_CONNECTIONS — the ceiling enforced when starting a new connection. */
    max: number;
}

export interface LegacyTagMigrationResult {
    alertConfigs: number;
    teveHistorizeTags: number;
    reports: number;
    reportVersions: number;
    dashboards: number;
    dashboardVersions: number;
    /** True when this was a preview — nothing was changed. */
    dryRun?: boolean;
    /** Up to 20 example rewrites (dry-run only). */
    samples?: Array<{ store: string; from: string; to: string }>;
}

export interface OpcuaTagInfo {
    nodeId: string;
    browseName: string;
    displayName: string;
    description?: string;
    nodeClass: string;
    typeDefinition?: string;
    dataType?: string;
}
