import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import {
    OpcuaConfiguration,
    OpcuaConfig,
} from '@/types/opcuaConfig';
import { encryptionService } from '@/services/encryptionService';
import { apiLogger } from '@/utils/logger';
import { getDatabasePath } from '@/config/environment';
import { createError } from '@/middleware/errorHandler';
import { aliasFromName, isValidAlias } from '@/services/opcua/tagResolver';
import { opcuaManager, ResolvedOpcuaConfig } from '@/services/opcua/opcuaConnectionManager';

const CONFIG_FILE_VERSION = 2;

/**
 * Persists OPC UA connection configurations (opcua-configs.json, v2).
 *
 * v2 supports many simultaneously enabled connections and an OPTIONAL
 * legacy-default connection: unqualified `opcua:<nodeId>` tags resolve only
 * when an admin has explicitly designated one (legacyDefaultConnectionId is
 * null by default — including after the v1→v2 migration).
 */
export class OpcuaConfigService {
    private configurations: Map<string, OpcuaConfiguration> = new Map();
    private legacyDefaultConnectionId: string | null = null;
    private readonly configFileName = 'opcua-configs.json';
    private isInitialized = false;

    constructor() {
        this.loadConfigurations();
    }

    async saveConfiguration(config: OpcuaConfig, userId: string): Promise<string> {
        try {
            const configId = config.id || uuidv4();
            const existingConfig = this.configurations.get(configId);

            let encryptedPassword: string | undefined = existingConfig?.encryptedPassword;
            if (config.password) {
                encryptedPassword = JSON.stringify(encryptionService.encrypt(config.password));
            }

            const alias = this.resolveAlias(config.alias, config.name, configId);

            const opcuaConfig: OpcuaConfiguration = {
                id: configId,
                name: config.name,
                alias,
                endpointUrl: config.endpointUrl,
                securityMode: config.securityMode,
                securityPolicy: config.securityPolicy,
                authenticationMode: config.authenticationMode,
                username: config.username || '',
                encryptedPassword,
                enabled: existingConfig?.enabled || false,
                collectorId: existingConfig?.collectorId ?? null,
                createdBy: userId,
                createdAt: existingConfig ? existingConfig.createdAt : new Date(),
                status: existingConfig ? existingConfig.status : 'untested',
                lastTested: existingConfig?.lastTested,
                lastError: existingConfig?.lastError
            };

            this.configurations.set(configId, opcuaConfig);
            await this.persistConfigurations();

            apiLogger.info('OPC UA configuration saved', { configId, name: config.name, alias });
            return configId;
        } catch (error) {
            apiLogger.error('Failed to save OPC UA configuration', error);
            throw error;
        }
    }

    private resolveAlias(requested: string | undefined, name: string, configId: string): string {
        const candidate = requested?.trim() || aliasFromName(name);
        if (requested && !isValidAlias(requested.trim())) {
            throw createError(
                'Invalid alias: use 2-32 lowercase letters, digits, or hyphens',
                400
            );
        }
        // De-dupe against other configs' aliases
        let alias = candidate;
        let n = 2;
        while (
            Array.from(this.configurations.values()).some(
                c => c.id !== configId && c.alias === alias
            )
        ) {
            if (requested) {
                throw createError(`Alias '${requested}' is already in use`, 400);
            }
            alias = `${candidate.slice(0, 28)}-${n++}`;
        }
        return alias;
    }

    async loadConfiguration(configId: string): Promise<OpcuaConfig> {
        const config = this.configurations.get(configId);
        if (!config) throw createError('Configuration not found', 404);

        let password: string | undefined;
        if (config.encryptedPassword) {
            password = encryptionService.decrypt(JSON.parse(config.encryptedPassword));
        }

        return {
            id: config.id,
            name: config.name,
            alias: config.alias,
            endpointUrl: config.endpointUrl,
            securityMode: config.securityMode,
            securityPolicy: config.securityPolicy,
            authenticationMode: config.authenticationMode,
            username: config.username || '',
            password
        };
    }

    /** Decrypted config in the shape the connection manager consumes. */
    async loadResolvedConfiguration(configId: string): Promise<ResolvedOpcuaConfig> {
        const stored = this.configurations.get(configId);
        if (!stored) throw createError('Configuration not found', 404);
        const config = await this.loadConfiguration(configId);
        return {
            ...config,
            id: stored.id,
            alias: stored.alias,
            collectorId: stored.collectorId ?? null,
        };
    }

    async listConfigurations(): Promise<OpcuaConfiguration[]> {
        return Array.from(this.configurations.values());
    }

    getConfiguration(configId: string): OpcuaConfiguration | null {
        return this.configurations.get(configId) || null;
    }

    async deleteConfiguration(configId: string): Promise<{ alertConfigsUnbound: number; teveTagsUnbound: number }> {
        if (this.legacyDefaultConnectionId === configId) {
            throw createError('Cannot delete the legacy-default connection — clear it first', 400);
        }
        await opcuaManager.stopConnection(configId);
        this.configurations.delete(configId);
        await this.persistConfigurations();

        // Unbind referencing rows so a deleted connection leaves explicit
        // unqualified rows (surfaced via unresolvedLegacyTagCount) instead of
        // dangling connection ids.
        const { alertManagementService } = await import('@/services/alertManagementService');
        const { teveTagConfigService } = await import('@/services/teveTagConfigService');
        const alertConfigsUnbound = alertManagementService.clearConnectionReferences(configId);
        const teveTagsUnbound = teveTagConfigService.clearConnectionReferences(configId);
        if (alertConfigsUnbound + teveTagsUnbound > 0) {
            apiLogger.warn(
                `Deleted OPC UA connection ${configId} was referenced — unbound ${alertConfigsUnbound} alert config(s) and ${teveTagsUnbound} TEVE historize tag(s)`
            );
        }
        return { alertConfigsUnbound, teveTagsUnbound };
    }

    async setEnabled(configId: string, enabled: boolean): Promise<void> {
        const config = this.configurations.get(configId);
        if (!config) throw createError('Configuration not found', 404);
        config.enabled = enabled;
        await this.persistConfigurations();

        if (enabled) {
            const resolved = await this.loadResolvedConfiguration(configId);
            await opcuaManager.startConnection(resolved);
        } else {
            await opcuaManager.stopConnection(configId);
        }
    }

    getLegacyDefaultConnectionId(): string | null {
        return this.legacyDefaultConnectionId;
    }

    /**
     * Designate (or clear, with null) the connection that unqualified legacy
     * `opcua:<nodeId>` tags resolve to. This is the explicit admin opt-in —
     * there is no automatic default.
     */
    async setLegacyDefaultConnection(configId: string | null): Promise<void> {
        if (configId !== null && !this.configurations.has(configId)) {
            throw createError('Configuration not found', 404);
        }
        this.legacyDefaultConnectionId = configId;
        opcuaManager.setLegacyDefaultConnectionId(configId);
        await this.persistConfigurations();
        apiLogger.info(
            configId
                ? `Legacy-default OPC UA connection set to ${configId}`
                : 'Legacy-default OPC UA connection cleared'
        );
    }

    private async loadConfigurations(): Promise<void> {
        const configFile = getDatabasePath(this.configFileName);
        try {
            const data = await fs.readFile(configFile, 'utf-8');
            const parsed = JSON.parse(data);

            this.configurations.clear();
            for (const config of parsed.configurations || []) {
                config.createdAt = new Date(config.createdAt);
                if (config.lastTested) config.lastTested = new Date(config.lastTested);
                this.configurations.set(config.id, config);
            }

            if (!parsed.version || parsed.version < CONFIG_FILE_VERSION) {
                this.migrateV1ToV2(parsed);
                await this.persistConfigurations();
                apiLogger.info('opcua-configs.json migrated to v2 (legacy fallback remains disabled)');
            } else {
                this.legacyDefaultConnectionId = parsed.legacyDefaultConnectionId ?? null;
            }
            opcuaManager.setLegacyDefaultConnectionId(this.legacyDefaultConnectionId);
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                apiLogger.error('Failed to load OPC UA configurations', error);
            }
        }
    }

    /**
     * v1 → v2: enabled takes over from isActive, aliases are generated from
     * names, and legacyDefaultConnectionId stays null — the previously active
     * connection does NOT silently become the target of unqualified tags
     * (user decision: the legacy fallback is opt-in).
     */
    private migrateV1ToV2(parsed: any): void {
        for (const config of this.configurations.values()) {
            if (config.enabled === undefined) {
                config.enabled = config.isActive === true || config.id === parsed.activeConfigId;
            }
            if (!config.alias) {
                config.alias = this.resolveAlias(undefined, config.name, config.id);
            }
            if (config.collectorId === undefined) {
                config.collectorId = null;
            }
            delete (config as any).isActive;
        }
        this.legacyDefaultConnectionId = null;
    }

    private async persistConfigurations(): Promise<void> {
        const configFile = getDatabasePath(this.configFileName);
        try {
            // Ensure data directory exists
            if (!this.isInitialized) {
                const dataDir = path.dirname(configFile);
                try {
                    const fsSync = require('fs');
                    if (!fsSync.existsSync(dataDir)) {
                        apiLogger.info(`Creating missing directory for OPC UA configs: ${dataDir}`);
                        fsSync.mkdirSync(dataDir, { recursive: true });
                    }
                } catch (e) {
                    apiLogger.warn('Sync directory check failed in ConfigService', e);
                }
            }

            const data = {
                version: CONFIG_FILE_VERSION,
                legacyDefaultConnectionId: this.legacyDefaultConnectionId,
                configurations: Array.from(this.configurations.values()),
                lastUpdated: new Date().toISOString()
            };

            // Atomic write: a crash mid-write (e.g. during an upgrade) must not
            // corrupt the only copy of every connection's credentials.
            const tmpFile = `${configFile}.tmp`;
            await fs.writeFile(tmpFile, JSON.stringify(data, null, 2));
            await fs.rename(tmpFile, configFile);
            apiLogger.debug(`OPC UA configurations persisted to ${configFile}`);
        } catch (error: any) {
            apiLogger.error('Failed to persist OPC UA configurations', {
                error: error.message,
                code: error.code,
                errno: error.errno,
                path: configFile
            });
            throw createError('Failed to save configurations to disk', 500);
        }
    }

    /**
     * Start every enabled connection on boot. Individual failures are left to
     * each connection's supervised reconnect; server startup never blocks on
     * an unreachable PLC.
     */
    async initializeConnections(): Promise<void> {
        if (this.isInitialized) return;

        try {
            await this.loadConfigurations();
            const enabled = Array.from(this.configurations.values()).filter(c => c.enabled);
            if (enabled.length > 0) {
                const resolved = await Promise.all(
                    enabled.map(c => this.loadResolvedConfiguration(c.id))
                );
                // Fire-and-forget: the manager's concurrency limiter paces the
                // handshakes and supervised reconnect handles stragglers.
                opcuaManager.startConnections(resolved).catch(error => {
                    apiLogger.error('Error starting OPC UA connections', error);
                });
                apiLogger.info(`OPC UA: starting ${enabled.length} enabled connection(s)`);
            }
            this.isInitialized = true;
        } catch (error) {
            apiLogger.error('Failed to initialize OPC UA connections', error);
            // Don't throw, we want the server to start even if OPC UA fails
        }
    }
}

export const opcuaConfigService = new OpcuaConfigService();

export function setupOpcuaConfigIntegration(): void {
    // Attempt initialization on startup
    opcuaConfigService.initializeConnections().catch(error => {
        apiLogger.error('Critical error in OPC UA setup:', error);
    });
}
