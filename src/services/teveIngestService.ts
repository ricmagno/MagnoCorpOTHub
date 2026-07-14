import { logger } from '@/utils/logger';
import { opcuaManager } from './opcua/opcuaConnectionManager';
import { OpcuaDataValue } from '@/types/opcua';
import { teveConfigService } from './teveConfigService';
import { teveTagConfigService, TeveHistorizeTag } from './teveTagConfigService';

const SUBSCRIPTION_KEY = 'teve-ingest';
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 2000;

interface PendingMetric {
  tagName: string;
  value: number | null;
  status: string;
  unit: string | null;
  time: string;
}

/**
 * Continuously historizes admin-selected OPC UA tags (see teveTagConfigService) into
 * TEVE — the Tensor Embedding Vector Engine, our separate, optional service that stores
 * time-series data alongside vector embeddings (of screenshots, metric windows, and
 * anomaly signatures) for similarity search — so it can serve as a genuine
 * alternative/parallel historian rather than only powering the Insights tab's search
 * features. Pushes over HTTP to TEVE's own ingest endpoint (never touches its database
 * directly — same "reach TEVE only via its configured baseUrl" boundary as the
 * browser-facing proxy).
 *
 * Multi-connection aware: tags are grouped by their OPC UA connection and each
 * group subscribes on its own connection (subscription key SUBSCRIPTION_KEY,
 * independent of alertEvalService's). Each connection reports into TEVE as its
 * own SCADA system, derived from the connection name. Tags with no
 * connectionId ride the legacy-default connection only when an admin has
 * designated one (the fallback is off by default).
 */
class TeveIngestService {
  private runningConnections = new Set<string>();
  private started = false;
  private flushTimer: NodeJS.Timeout | null = null;
  // Pending metrics are bucketed per SCADA system (one per connection) so a
  // single flush posts one ingest batch per connection.
  private pendingBySystem: Map<string, { name: string; metrics: PendingMetric[] }> = new Map();

  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      opcuaManager.onAnyConnect((connectionId) => {
        this.setupSubscriptionsForConnection(connectionId).catch((err) =>
          logger.error(`TeveIngestService: failed to set up subscriptions after connect (${connectionId}):`, err)
        );
      });
      opcuaManager.onAnyReconnect((connectionId) => {
        this.refreshConnection(connectionId).catch((err) =>
          logger.error(`TeveIngestService: failed to refresh after reconnect (${connectionId}):`, err)
        );
      });
    }

    const live = opcuaManager.listProviders().filter((p) => p.hasSession());
    if (live.length === 0) {
      logger.info('TeveIngestService: no OPC UA sessions yet — will activate on first connect');
      return;
    }
    for (const provider of live) {
      await this.setupSubscriptionsForConnection(provider.connectionId);
    }
  }

  async stop(): Promise<void> {
    await opcuaManager.terminateSubscriptionAll(SUBSCRIPTION_KEY);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.runningConnections.clear();
  }

  async refresh(): Promise<void> {
    logger.info('TeveIngestService: refreshing subscriptions');
    await this.stop();
    for (const provider of opcuaManager.listProviders()) {
      if (provider.hasSession()) {
        await this.setupSubscriptionsForConnection(provider.connectionId);
      }
    }
  }

  async refreshConnection(connectionId: string): Promise<void> {
    const provider = opcuaManager.findProvider(connectionId);
    if (!provider) return;
    try {
      await provider.terminateSubscription(SUBSCRIPTION_KEY);
    } catch (err) {
      logger.warn(`TeveIngestService: error terminating '${SUBSCRIPTION_KEY}' on ${connectionId}:`, err);
    }
    this.runningConnections.delete(connectionId);
    await this.setupSubscriptionsForConnection(connectionId);
  }

  /** Historize tags bound to this connection (including legacy-default routing). */
  private tagsForConnection(connectionId: string): TeveHistorizeTag[] {
    const tags = teveTagConfigService.list();
    const legacyId = opcuaManager.getLegacyDefaultConnectionId();
    const skipped: string[] = [];
    const matched = tags.filter((tag) => {
      if (tag.connectionId) return tag.connectionId === connectionId;
      if (legacyId) return legacyId === connectionId;
      skipped.push(tag.tagName);
      return false;
    });
    if (skipped.length > 0) {
      logger.warn(
        `TeveIngestService: ${skipped.length} historize tag(s) have no OPC UA connection and no legacy-default connection is designated — skipped: ${skipped.join(', ')}`
      );
    }
    return matched;
  }

  private async setupSubscriptionsForConnection(connectionId: string): Promise<void> {
    if (this.runningConnections.has(connectionId)) return;

    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) {
      logger.info('TeveIngestService: TEVE not configured/enabled — skipping');
      return;
    }

    const provider = opcuaManager.findProvider(connectionId);
    if (!provider || !provider.hasSession()) return;

    const tags = this.tagsForConnection(connectionId);
    if (tags.length === 0) {
      logger.info(`TeveIngestService: no tags configured to historize on '${provider.name}' — skipping`);
      return;
    }

    // Each connection reports as its own SCADA system in TEVE.
    const scadaSystemId = `opcua-${provider.name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const scadaSystemName = provider.name;

    await provider.createSubscription(SUBSCRIPTION_KEY, 1000);
    this.runningConnections.add(connectionId);

    for (const tag of tags) {
      await provider.monitorNode(SUBSCRIPTION_KEY, tag.nodeId, 1000, (dv: OpcuaDataValue) => {
        this.enqueue(scadaSystemId, scadaSystemName, tag.tagName, dv, tag.unit);
      });
    }

    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => logger.error('TeveIngestService: flush failed:', err));
      }, FLUSH_INTERVAL_MS);
    }

    logger.info(`TeveIngestService: historizing ${tags.length} tag(s) from '${provider.name}' into TEVE`);
  }

  private enqueue(
    scadaSystemId: string,
    scadaSystemName: string,
    tagName: string,
    dv: OpcuaDataValue,
    unit: string | null
  ): void {
    let bucket = this.pendingBySystem.get(scadaSystemId);
    if (!bucket) {
      bucket = { name: scadaSystemName, metrics: [] };
      this.pendingBySystem.set(scadaSystemId, bucket);
    }
    if (bucket.metrics.length >= MAX_BATCH) return; // drop rather than grow unbounded if the sink is down
    const status = dv.statusName === 'Good' || dv.statusName === 'Uncertain' ? 'Good' : 'Bad';
    const rawValue = dv.value;
    const value = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'boolean' ? (rawValue ? 1 : 0) : null;
    const time = dv.sourceTimestamp ?? dv.serverTimestamp ?? new Date().toISOString();
    bucket.metrics.push({ tagName, value, status, unit, time });
  }

  private async flush(): Promise<void> {
    if (this.pendingBySystem.size === 0) return;
    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) {
      this.pendingBySystem.clear();
      return;
    }
    const batches = Array.from(this.pendingBySystem.entries());
    this.pendingBySystem = new Map();

    for (const [systemId, bucket] of batches) {
      if (bucket.metrics.length === 0) continue;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(`${baseUrl}/api/teve/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scadaSystem: { id: systemId, name: bucket.name },
            metrics: bucket.metrics,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          logger.warn(`TeveIngestService: ingest returned ${res.status}`, { count: bucket.metrics.length, systemId });
        }
      } catch (err) {
        logger.warn('TeveIngestService: ingest request failed (batch dropped):', err);
      }
    }
  }
}

export const teveIngestService = new TeveIngestService();
