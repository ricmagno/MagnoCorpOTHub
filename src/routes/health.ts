/**
 * Health Check API Routes
 * Provides system health monitoring and status endpoints
 * Requirements: 11.4
 */

import { Router, Request, Response } from 'express';
import { getHistorianConnection } from '@/services/historianConnection';
import { cacheManager } from '@/services/cacheManager';
import { apiLogger } from '@/utils/logger';
import { asyncHandler } from '@/middleware/errorHandler';
import { env } from '@/config/environment';
import { databaseConfigService } from '@/services/databaseConfigService';
import { opcuaConfigService } from '@/services/opcuaConfigService';
import { opcuaManager } from '@/services/opcua/opcuaConnectionManager';
import { countUnresolvedLegacyTags } from '@/services/opcua/legacyTagStats';
import { teveConfigService } from '@/services/teveConfigService';

const router = Router();

type ServiceStatus = 'healthy' | 'unhealthy' | 'not_configured' | 'disabled';

interface ServiceHealth {
  configured: boolean;
  status: ServiceStatus;
  detail?: string;
  /** Per-connection detail for multi-connection services (OPC UA). */
  connections?: Array<{
    id: string;
    name: string;
    alias: string;
    status: string;
    lastError?: string | undefined;
    isLegacyDefault: boolean;
    subscriptionCount?: number;
    monitoredItemCount?: number;
    lastDataTimestamp?: string | undefined;
  }>;
  /** Stored tag rows with no connection binding while the legacy fallback is off. */
  unresolvedLegacyTagCount?: number;
}

/**
 * GET /api/health
 * Basic health check endpoint
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { versionManager } = await import('@/services/versionManager');
  const versionInfo = versionManager.getCurrentVersion();

  const healthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: versionInfo.version,
    environment: env.NODE_ENV,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    services: {
      historian: 'unknown',
      cache: 'unknown'
    },
    serverTime: {
      utc: new Date().toISOString(),
      local: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset()
    }
  };


  // Test services in parallel for better performance and to prevent cumulative timeouts
  const [historianHealthy, cacheHealthResult] = await Promise.all([
    (async () => {
      try {
        const historianConnection = getHistorianConnection();
        return await historianConnection.validateConnection();
      } catch (error) {
        apiLogger.warn('Historian connection health check failed:', error);
        return false;
      }
    })(),
    (async () => {
      try {
        const health = await cacheManager.healthCheck();
        return health.cacheHealthy;
      } catch (error) {
        apiLogger.warn('Cache health check failed:', error);
        return false;
      }
    })()
  ]);

  healthStatus.services.historian = historianHealthy ? 'healthy' : 'unhealthy';
  healthStatus.services.cache = cacheHealthResult ? 'healthy' : 'unhealthy';

  // Determine overall status
  const allServicesHealthy = Object.values(healthStatus.services).every(status => status === 'healthy');
  if (!allServicesHealthy) {
    healthStatus.status = 'degraded';
  }

  const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(healthStatus);
}));

/**
 * GET /api/health/detailed
 * Detailed health check with component-specific information
 */
router.get('/detailed', asyncHandler(async (req: Request, res: Response) => {
  const { versionManager } = await import('@/services/versionManager');
  const versionInfo = versionManager.getCurrentVersion();

  const detailedHealth = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: versionInfo.version,
    environment: env.NODE_ENV,
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      platform: process.platform,
      nodeVersion: process.version
    },
    services: {
      historian: {
        status: 'unknown',
        connectionStatus: null as any,
        lastCheck: null as string | null
      },
      cache: {
        status: 'unknown',
        enabled: false,
        connected: false,
        stats: null as any,
        lastCheck: null as string | null
      }
    },
    serverTime: {
      utc: new Date().toISOString(),
      local: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset()
    }
  };


  // Detailed checks in parallel
  await Promise.all([
    (async () => {
      try {
        const historianConnection = getHistorianConnection();
        const historianHealthy = await historianConnection.validateConnection();
        const connectionStatus = historianConnection.getConnectionStatus();

        detailedHealth.services.historian = {
          status: historianHealthy ? 'healthy' : 'unhealthy',
          connectionStatus,
          lastCheck: new Date().toISOString()
        };
      } catch (error) {
        detailedHealth.services.historian.status = 'unhealthy';
        detailedHealth.services.historian.lastCheck = new Date().toISOString();
        apiLogger.warn('Detailed historian health check failed:', error);
      }
    })(),
    (async () => {
      try {
        const cacheHealth = await cacheManager.healthCheck();
        const cacheStats = await cacheManager.getCacheStats();

        detailedHealth.services.cache = {
          status: cacheHealth.cacheHealthy ? 'healthy' : 'unhealthy',
          enabled: cacheHealth.cacheEnabled,
          connected: cacheHealth.cacheHealthy,
          stats: cacheStats,
          lastCheck: new Date().toISOString()
        };
      } catch (error) {
        detailedHealth.services.cache.status = 'unhealthy';
        detailedHealth.services.cache.lastCheck = new Date().toISOString();
        apiLogger.warn('Detailed cache health check failed:', error);
      }
    })()
  ]);

  // Determine overall status
  const allServicesHealthy = Object.values(detailedHealth.services)
    .every(service => service.status === 'healthy');

  if (!allServicesHealthy) {
    detailedHealth.status = 'degraded';
  }

  const statusCode = detailedHealth.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(detailedHealth);
}));


/**
 * GET /api/health/historian
 * Historian connection-specific health check
 */
router.get('/historian', asyncHandler(async (req: Request, res: Response) => {
  const historianHealth = {
    status: 'unknown',
    timestamp: new Date().toISOString(),
    connection: null as any,
    test: {
      successful: false,
      duration: 0,
      error: null as string | null
    },
    serverTime: {
      utc: new Date().toISOString(),
      local: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset()
    }
  };

  const startTime = Date.now();

  try {
    const historianConnection = getHistorianConnection();
    const isHealthy = await historianConnection.validateConnection();
    const connectionStatus = historianConnection.getConnectionStatus();
    const duration = Date.now() - startTime;

    historianHealth.status = isHealthy ? 'healthy' : 'unhealthy';
    historianHealth.connection = connectionStatus;
    historianHealth.test = {
      successful: isHealthy,
      duration,
      error: null
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    historianHealth.status = 'unhealthy';
    historianHealth.test = {
      successful: false,
      duration,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }

  const statusCode = historianHealth.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(historianHealth);
}));

/**
 * GET /api/health/services
 * Combined status for every independently-configurable data-source integration
 * (AVEVA Historian, OPC UA, TEVE) — each is optional, so "not configured"
 * and "disabled" are distinct, non-error states from "unhealthy". Powers the header
 * status indicator, which used to reflect AVEVA Historian alone.
 */
router.get('/services', asyncHandler(async (_req: Request, res: Response) => {
  const [historian, opcua, tensor] = await Promise.all([
    (async (): Promise<ServiceHealth> => {
      const activeConfig = databaseConfigService.getActiveConfiguration();
      if (!activeConfig) return { configured: false, status: 'not_configured' };
      try {
        const healthy = await getHistorianConnection().validateConnection();
        return { configured: true, status: healthy ? 'healthy' : 'unhealthy' };
      } catch (error) {
        return { configured: true, status: 'unhealthy', detail: error instanceof Error ? error.message : 'Unknown error' };
      }
    })(),
    (async (): Promise<ServiceHealth> => {
      try {
        const configs = await opcuaConfigService.listConfigurations();
        const enabled = configs.filter((c) => c.enabled);
        if (enabled.length === 0) return { configured: false, status: 'not_configured' };
        const connections = opcuaManager.health();
        // Healthy only when every enabled connection has a live session.
        const allConnected =
          connections.length > 0 &&
          enabled.every((c) => opcuaManager.findProvider(c.id)?.hasSession());
        const health: ServiceHealth = {
          configured: true,
          status: allConnected ? 'healthy' : 'unhealthy',
          connections,
        };
        // Rows that silently do nothing until an admin acts — only meaningful
        // while the legacy fallback is off.
        if (opcuaManager.getLegacyDefaultConnectionId() === null) {
          const count = countUnresolvedLegacyTags();
          if (count > 0) health.unresolvedLegacyTagCount = count;
        }
        return health;
      } catch (error) {
        return { configured: false, status: 'not_configured', detail: error instanceof Error ? error.message : 'Unknown error' };
      }
    })(),
    (async (): Promise<ServiceHealth> => {
      const config = teveConfigService.getConfig();
      if (!config.enabled) return { configured: false, status: 'disabled' };
      if (!config.baseUrl) return { configured: true, status: 'not_configured' };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        let ok: boolean;
        try {
          const response = await fetch(`${config.baseUrl}/health`, { signal: controller.signal });
          ok = response.ok;
        } finally {
          clearTimeout(timeout);
        }
        return { configured: true, status: ok ? 'healthy' : 'unhealthy' };
      } catch (error) {
        return { configured: true, status: 'unhealthy', detail: error instanceof Error ? error.message : 'Unknown error' };
      }
    })()
  ]);

  const services = { historian, opcua, tensor };
  const anyUnhealthy = Object.values(services).some((s) => s.status === 'unhealthy');

  const mem = process.memoryUsage();
  res.json({
    status: anyUnhealthy ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    services,
    // Watch this at 50+ OPC UA connections — see spec/deployment.md sizing.
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
    serverTime: {
      utc: new Date().toISOString(),
      local: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset()
    }
  });
}));

/**
 * GET /api/health/cache
 * Cache-specific health check
 */
router.get('/cache', asyncHandler(async (req: Request, res: Response) => {
  const cacheHealth = {
    status: 'unknown',
    timestamp: new Date().toISOString(),
    enabled: env.CACHE_ENABLED,
    configuration: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      database: env.REDIS_DB,
      keyPrefix: env.CACHE_KEY_PREFIX,
      defaultTTL: env.CACHE_DEFAULT_TTL
    },
    test: {
      successful: false,
      duration: 0,
      error: null as string | null
    },
    stats: null as any
  };

  const startTime = Date.now();

  try {
    const healthCheck = await cacheManager.healthCheck();
    const stats = await cacheManager.getCacheStats();
    const duration = Date.now() - startTime;

    cacheHealth.status = healthCheck.cacheHealthy ? 'healthy' : 'unhealthy';
    cacheHealth.test = {
      successful: healthCheck.cacheHealthy,
      duration,
      error: null
    };
    cacheHealth.stats = stats;
  } catch (error) {
    const duration = Date.now() - startTime;

    cacheHealth.status = 'unhealthy';
    cacheHealth.test = {
      successful: false,
      duration,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }

  const statusCode = cacheHealth.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(cacheHealth);
}));

export default router;