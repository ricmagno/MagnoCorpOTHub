import { apiLogger } from '@/utils/logger';

/**
 * Count of stored OPC UA tag rows with no connection binding (alert configs +
 * TEVE historize tags). Meaningful when no legacy-default connection is
 * designated: these rows are skipped until an admin designates one or runs
 * POST /api/opcua/migrate-legacy-tags. Surfaced in /api/health/services so
 * the UI can show an upgrade banner.
 *
 * Lazily requires the SQLite-backed services so importing this module (e.g.
 * from the health route) doesn't open databases at load time.
 */
export function countUnresolvedLegacyTags(): number {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { alertManagementService } = require('@/services/alertManagementService');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { teveTagConfigService } = require('@/services/teveTagConfigService');
        return alertManagementService.countUnqualified() + teveTagConfigService.countUnqualified();
    } catch (error) {
        apiLogger.warn('Failed to count unresolved legacy OPC UA tags', error);
        return 0;
    }
}
