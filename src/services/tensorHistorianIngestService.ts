import { DataValue } from 'node-opcua';
import { logger } from '@/utils/logger';
import { opcuaService } from './opcuaService';
import { opcuaConfigService } from './opcuaConfigService';
import { teveConfigService } from './teveConfigService';
import { teveTagConfigService } from './teveTagConfigService';

const SUBSCRIPTION_KEY = 'tensor-historian';
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
 * Tensor Historian, so it can serve as a genuine alternative/parallel historian rather
 * than only powering the Insights tab's search features. Pushes over HTTP to the
 * historian service's own ingest endpoint (never touches its database directly — same
 * "reach TEVE only via its configured baseUrl" boundary as the browser-facing proxy).
 *
 * Owns its own OPC UA subscription (SUBSCRIPTION_KEY), independent of
 * alertEvalService's — see the multi-subscription support added to opcuaService.ts.
 */
class TensorHistorianIngestService {
  private isRunning = false;
  private pending: PendingMetric[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private scadaSystemId = 'opcua-source';
  private scadaSystemName = 'OPC UA Source';

  async start(): Promise<void> {
    opcuaService.onConnect(() => {
      this.setupSubscriptions().catch((err) =>
        logger.error('TensorHistorianIngestService: failed to set up subscriptions after connect:', err)
      );
    });
    opcuaService.onReconnect(() => {
      this.refresh().catch((err) =>
        logger.error('TensorHistorianIngestService: failed to refresh after reconnect:', err)
      );
    });

    if (opcuaService.hasSession()) {
      await this.setupSubscriptions();
    } else {
      logger.info('TensorHistorianIngestService: no OPC UA session yet — will activate on first connect');
    }
  }

  async stop(): Promise<void> {
    await opcuaService.terminateSubscription(SUBSCRIPTION_KEY);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.isRunning = false;
  }

  async refresh(): Promise<void> {
    logger.info('TensorHistorianIngestService: refreshing subscriptions');
    await this.stop();
    await this.setupSubscriptions();
  }

  private async setupSubscriptions(): Promise<void> {
    if (this.isRunning) return;

    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) {
      logger.info('TensorHistorianIngestService: Tensor Historian not configured/enabled — skipping');
      return;
    }

    const tags = teveTagConfigService.list();
    if (tags.length === 0) {
      logger.info('TensorHistorianIngestService: no tags configured to historize — skipping');
      return;
    }

    try {
      const activeConfig = await opcuaConfigService.loadConfiguration(
        (await opcuaConfigService.listConfigurations()).find((c) => c.isActive)?.id ?? ''
      );
      this.scadaSystemId = `opcua-${activeConfig.name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      this.scadaSystemName = activeConfig.name;
    } catch {
      // No active OPC UA config resolvable by name; fall back to the generic identity
      // set in the field defaults above rather than fail startup entirely.
    }

    await opcuaService.createSubscription(SUBSCRIPTION_KEY, 1000);
    this.isRunning = true;

    for (const tag of tags) {
      opcuaService.monitorNode(SUBSCRIPTION_KEY, tag.nodeId, 1000, (dv: DataValue) => {
        this.enqueue(tag.tagName, dv, tag.unit);
      });
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => logger.error('TensorHistorianIngestService: flush failed:', err));
    }, FLUSH_INTERVAL_MS);

    logger.info(`TensorHistorianIngestService: historizing ${tags.length} tag(s) into Tensor Historian`);
  }

  private enqueue(tagName: string, dv: DataValue, unit: string | null): void {
    if (this.pending.length >= MAX_BATCH) return; // drop rather than grow unbounded if the sink is down
    const status = dv.statusCode?.name === 'Good' || dv.statusCode?.name === 'Uncertain' ? 'Good' : 'Bad';
    const rawValue = dv.value?.value;
    const value = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'boolean' ? (rawValue ? 1 : 0) : null;
    const time = (dv.sourceTimestamp ?? dv.serverTimestamp ?? new Date()).toISOString();
    this.pending.push({ tagName, value, status, unit, time });
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) {
      this.pending = [];
      return;
    }
    const batch = this.pending;
    this.pending = [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${baseUrl}/api/teve/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scadaSystem: { id: this.scadaSystemId, name: this.scadaSystemName },
          metrics: batch,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        logger.warn(`TensorHistorianIngestService: ingest returned ${res.status}`, { count: batch.length });
      }
    } catch (err) {
      logger.warn('TensorHistorianIngestService: ingest request failed (batch dropped):', err);
    }
  }
}

export const tensorHistorianIngestService = new TensorHistorianIngestService();
