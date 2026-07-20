import { logger } from '../utils/logger';
import { alertManagementService } from './alertManagementService';
import { smsService } from './smsService';
import { brandingService } from './brandingService';
import { opcuaManager } from './opcua/opcuaConnectionManager';
import { OpcuaDataValue } from '../types/opcua';
import { AlertConfig } from '../types/alerts';

const SUBSCRIPTION_KEY = 'alerts';

/**
 * Service to evaluate alerts via OPC UA subscriptions (push-based).
 *
 * Multi-connection aware: alert configs are grouped by their OPC UA
 * connection and each group subscribes on its own connection, so one PLC
 * reconnecting rebuilds only that connection's monitors — never the whole
 * fleet's. Configs without a connectionId are evaluated only when an admin
 * has designated a legacy-default connection (the fallback is off by default).
 */
export class AlertEvalService {
    private previousAlarmStates: Record<string, boolean> = {};
    private cachedPvValues: Map<string, any> = new Map();
    private runningConnections = new Set<string>();
    private started = false;

    constructor() { }

    /**
     * Start subscription-based alert evaluation.
     * Registers connect/reconnect hooks on the connection manager so
     * subscriptions are (re-)established per connection as sessions come up.
     */
    async start(): Promise<void> {
        if (!this.started) {
            this.started = true;
            opcuaManager.onAnyConnect((connectionId) => {
                this.setupSubscriptionsForConnection(connectionId).catch(err =>
                    logger.error(`AlertEvalService: failed to set up subscriptions after connect (${connectionId}):`, err)
                );
            });
            opcuaManager.onAnyReconnect((connectionId) => {
                this.refreshConnection(connectionId).catch(err =>
                    logger.error(`AlertEvalService: failed to refresh subscriptions after reconnect (${connectionId}):`, err)
                );
            });
        }

        // Set up immediately for any connections that already have sessions.
        const live = opcuaManager.listProviders().filter(p => p.hasSession());
        if (live.length === 0) {
            logger.info('AlertEvalService: no OPC UA sessions yet — subscriptions will activate on first connect');
            return;
        }
        for (const provider of live) {
            await this.setupSubscriptionsForConnection(provider.connectionId);
        }
    }

    /**
     * Stop all subscriptions and clear state.
     */
    async stop(): Promise<void> {
        await opcuaManager.terminateSubscriptionAll(SUBSCRIPTION_KEY);
        this.cachedPvValues.clear();
        this.previousAlarmStates = {};
        this.runningConnections.clear();
        logger.info('AlertEvalService stopped');
    }

    /**
     * Rebuild subscriptions on every connection (called after alert config changes).
     */
    async refresh(): Promise<void> {
        logger.info('AlertEvalService: refreshing subscriptions');
        await this.stop();
        for (const provider of opcuaManager.listProviders()) {
            if (provider.hasSession()) {
                await this.setupSubscriptionsForConnection(provider.connectionId);
            }
        }
    }

    /**
     * Rebuild only one connection's subscriptions (e.g. after that PLC reconnects).
     */
    async refreshConnection(connectionId: string): Promise<void> {
        logger.info(`AlertEvalService: refreshing subscriptions for connection ${connectionId}`);
        const provider = opcuaManager.findProvider(connectionId);
        if (!provider) return;
        try {
            await provider.terminateSubscription(SUBSCRIPTION_KEY);
        } catch (err) {
            logger.warn(`AlertEvalService: error terminating '${SUBSCRIPTION_KEY}' on ${connectionId}:`, err);
        }
        this.runningConnections.delete(connectionId);
        await this.setupSubscriptionsForConnection(connectionId);
    }

    /** Alert configs bound to this connection (including legacy-default routing). */
    private async configsForConnection(connectionId: string): Promise<AlertConfig[]> {
        const configs = await alertManagementService.getActiveAlertConfigs();
        const legacyId = opcuaManager.getLegacyDefaultConnectionId();
        const skipped: string[] = [];
        const matched = configs.filter(config => {
            if (config.connectionId) return config.connectionId === connectionId;
            if (legacyId) return legacyId === connectionId;
            skipped.push(config.name);
            return false;
        });
        if (skipped.length > 0) {
            logger.warn(
                `AlertEvalService: ${skipped.length} alert config(s) have no OPC UA connection and no legacy-default connection is designated — skipped: ${skipped.join(', ')}`
            );
        }
        return matched;
    }

    private async setupSubscriptionsForConnection(connectionId: string): Promise<void> {
        if (this.runningConnections.has(connectionId)) {
            logger.warn(`AlertEvalService: subscriptions already running for connection ${connectionId} — skipping`);
            return;
        }

        const provider = opcuaManager.findProvider(connectionId);
        if (!provider || !provider.hasSession()) return;

        const configs = await this.configsForConnection(connectionId);
        if (configs.length === 0) {
            logger.info(`AlertEvalService: no active alert configs for connection '${provider.name}'`);
            return;
        }

        // Pre-fetch all patterns once
        const patternIds = Array.from(new Set(configs.map(c => c.patternId).filter(Boolean)));
        const patternsMap = new Map<string, any>();
        for (const pId of patternIds) {
            const pattern = await alertManagementService.getAlertPatternById(pId);
            if (pattern) patternsMap.set(pId, pattern);
        }

        await provider.createSubscription(SUBSCRIPTION_KEY, 1000);
        this.runningConnections.add(connectionId);

        const getFullNodeId = (tagBase: string, suffix: string): string => {
            const prefix = suffix.startsWith('.') ? '' : '.';
            return `${tagBase}${prefix}${suffix}`;
        };

        for (const config of configs) {
            const pattern = patternsMap.get(config.patternId);
            if (!pattern) {
                logger.warn(`AlertEvalService: pattern ${config.patternId} not found for config ${config.id}`);
                continue;
            }

            const nodes = {
                HH: getFullNodeId(config.tagBase, pattern.hhEventSuffix),
                H: getFullNodeId(config.tagBase, pattern.hEventSuffix),
                L: getFullNodeId(config.tagBase, pattern.lEventSuffix),
                LL: getFullNodeId(config.tagBase, pattern.llEventSuffix),
                PV: getFullNodeId(config.tagBase, pattern.pvSuffix),
            };

            const hasAnyMonitor = config.monitorHH || config.monitorH || config.monitorL || config.monitorLL;

            // Subscribe to the PV so alarm messages include the current process value
            if (hasAnyMonitor) {
                await provider.monitorNode(SUBSCRIPTION_KEY, nodes.PV, 500, (dv: OpcuaDataValue) => {
                    this.cachedPvValues.set(nodes.PV, dv.value);
                });
            }

            if (config.monitorHH) {
                await provider.monitorNode(SUBSCRIPTION_KEY, nodes.HH, 500, (dv: OpcuaDataValue) =>
                    this.handleAlarm(config, 'High High (HH)', nodes.HH, nodes.PV, dv.value)
                );
            }
            if (config.monitorH) {
                await provider.monitorNode(SUBSCRIPTION_KEY, nodes.H, 500, (dv: OpcuaDataValue) =>
                    this.handleAlarm(config, 'High (H)', nodes.H, nodes.PV, dv.value)
                );
            }
            if (config.monitorL) {
                await provider.monitorNode(SUBSCRIPTION_KEY, nodes.L, 500, (dv: OpcuaDataValue) =>
                    this.handleAlarm(config, 'Low (L)', nodes.L, nodes.PV, dv.value)
                );
            }
            if (config.monitorLL) {
                await provider.monitorNode(SUBSCRIPTION_KEY, nodes.LL, 500, (dv: OpcuaDataValue) =>
                    this.handleAlarm(config, 'Low Low (LL)', nodes.LL, nodes.PV, dv.value)
                );
            }
        }

        logger.info(`AlertEvalService: subscriptions active for ${configs.length} alert config(s) on '${provider.name}'`);
    }

    private handleAlarm(config: any, alarmTypeStr: string, alarmNodeId: string, pvNodeId: string, alarmValue: any): void {
        const isAlarmActive = !!alarmValue;
        const stateKey = `${config.id}_${alarmNodeId}`;
        const wasAlarmActive = this.previousAlarmStates[stateKey] || false;

        if (isAlarmActive && !wasAlarmActive) {
            logger.info(`ALARM TRIGGERED: ${config.tagBase} ${alarmTypeStr}`);
            const pvValue = this.cachedPvValues.get(pvNodeId);

            alertManagementService.getAlertListById(config.alertListId)
                .then(alertList => {
                    if (!alertList?.members?.length) return;
                    const phones = alertList.members
                        .map((m: any) => m.phone)
                        .filter((p: any) => p && p.trim().length > 0) as string[];
                    if (phones.length === 0) return;

                    const message = `${brandingService.getSmsPrefix()}🚨 ALARM: ${config.name || config.tagBase}! Triggered: ${alarmTypeStr}. Current PV: ${pvValue !== undefined ? pvValue : 'Unknown'}. Please check the system!`;
                    return smsService.sendSms(phones, message);
                })
                .catch(err => logger.error('Failed to send SMS for alarm', { error: err }));

        } else if (!isAlarmActive && wasAlarmActive) {
            logger.info(`ALARM CLEARED: ${config.tagBase} ${alarmTypeStr}`);
        }

        this.previousAlarmStates[stateKey] = isAlarmActive;
    }
}

export const alertEvalService = new AlertEvalService();
