import Database from 'better-sqlite3';
import fs from 'fs';
import { getDatabasePath } from '@/config/environment';
import { apiLogger } from '@/utils/logger';
import { createError } from '@/middleware/errorHandler';
import { opcuaConfigService } from '@/services/opcuaConfigService';
import { alertManagementService } from '@/services/alertManagementService';
import { teveTagConfigService } from '@/services/teveTagConfigService';
import {
    OPCUA_TAG_PREFIX,
    TagRegistryView,
    formatOpcuaTag,
    parseOpcuaTag,
} from './tagResolver';

export interface LegacyTagMigrationResult {
    alertConfigs: number;
    teveHistorizeTags: number;
    reports: number;
    reportVersions: number;
    dashboards: number;
    dashboardVersions: number;
    /** True when this was a preview — nothing was changed. */
    dryRun?: boolean;
    /** Up to MAX_SAMPLES example rewrites (dry-run only). */
    samples?: Array<{ store: string; from: string; to: string }>;
}

const MAX_SAMPLES = 20;

/**
 * One-shot, admin-triggered migration that rewrites every stored unqualified
 * `opcua:<nodeId>` tag to the qualified `opcua:<alias>:<nodeId>` form, bound
 * to the given connection. Once run (and once new tags are always emitted
 * qualified), the legacy-default fallback can be retired.
 *
 * Idempotent: already-qualified tags are recognized against the full set of
 * configured connections (not just running ones) and left untouched.
 */
class LegacyTagMigrationService {
    /**
     * @param dryRun when true, nothing is written — returns the counts that a
     *   real run would produce plus sample rewrites, for a UI preview.
     */
    async migrate(connectionId: string, dryRun = false): Promise<LegacyTagMigrationResult> {
        const configs = await opcuaConfigService.listConfigurations();
        const target = configs.find(c => c.id === connectionId);
        if (!target) {
            throw createError('Configuration not found', 404);
        }

        // Registry over ALL configured connections, with the legacy fallback
        // forced off so parseOpcuaTag classifies unqualified tags as such.
        const registry: TagRegistryView = {
            resolveConnectionRef: (idOrAlias: string) => {
                const match = configs.find(c => c.id === idOrAlias || c.alias === idOrAlias);
                return match ? match.id : null;
            },
            getLegacyDefaultConnectionId: () => null,
        };

        const samples: Array<{ store: string; from: string; to: string }> = [];
        const rewriteTag = (store: string) => (tag: string): string | null => {
            if (!tag.startsWith(OPCUA_TAG_PREFIX)) return null;
            const parsed = parseOpcuaTag(tag, registry);
            if (!('error' in parsed)) return null; // already qualified
            const rewritten = formatOpcuaTag(target.alias, parsed.nodeId);
            if (samples.length < MAX_SAMPLES) {
                samples.push({ store, from: tag, to: rewritten });
            }
            return rewritten;
        };

        const result: LegacyTagMigrationResult = {
            alertConfigs: dryRun
                ? alertManagementService.countUnqualified()
                : alertManagementService.assignConnectionToUnqualified(connectionId),
            teveHistorizeTags: dryRun
                ? teveTagConfigService.countUnqualified()
                : teveTagConfigService.assignConnectionToUnqualified(connectionId),
            reports: 0,
            reportVersions: 0,
            dashboards: 0,
            dashboardVersions: 0,
        };

        const reportCounts = this.rewriteConfigTable(
            getDatabasePath('reports.db'),
            ['reports', 'report_versions'],
            rewriteTag('reports'),
            dryRun
        );
        result.reports = reportCounts[0] ?? 0;
        result.reportVersions = reportCounts[1] ?? 0;

        const dashboardCounts = this.rewriteConfigTable(
            getDatabasePath('dashboards.db'),
            ['dashboards', 'dashboard_versions'],
            rewriteTag('dashboards'),
            dryRun
        );
        result.dashboards = dashboardCounts[0] ?? 0;
        result.dashboardVersions = dashboardCounts[1] ?? 0;

        if (dryRun) {
            result.dryRun = true;
            result.samples = samples;
            apiLogger.info('Legacy OPC UA tag migration previewed (dry run)', { connectionId, ...result, samples: samples.length });
        } else {
            apiLogger.info('Legacy OPC UA tag migration completed', { connectionId, ...result });
        }
        return result;
    }

    /**
     * Rewrites opcua: strings inside each table's `config` JSON column
     * (counts only when dryRun). Returns the number of rows changed per table.
     */
    private rewriteConfigTable(
        dbPath: string,
        tables: string[],
        rewriteTag: (tag: string) => string | null,
        dryRun: boolean
    ): number[] {
        if (!fs.existsSync(dbPath)) return tables.map(() => 0);
        const db = new Database(dbPath);
        try {
            return tables.map(table => {
                const exists = db
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .get(table);
                if (!exists) return 0;

                let changed = 0;
                const rows = db.prepare(`SELECT id, config FROM ${table}`).all() as any[];
                const update = db.prepare(`UPDATE ${table} SET config = ? WHERE id = ?`);
                for (const row of rows) {
                    try {
                        const config = JSON.parse(row.config);
                        if (rewriteDeep(config, rewriteTag)) {
                            if (!dryRun) {
                                update.run(JSON.stringify(config), row.id);
                            }
                            changed++;
                        }
                    } catch (err) {
                        apiLogger.warn(`Skipping unparseable config row during tag migration`, {
                            table,
                            id: row.id,
                        });
                    }
                }
                return changed;
            });
        } finally {
            db.close();
        }
    }
}

/** Rewrites matching strings anywhere in a JSON value tree. Returns true if anything changed. */
function rewriteDeep(value: unknown, rewrite: (s: string) => string | null): boolean {
    let changed = false;
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            if (typeof item === 'string') {
                const next = rewrite(item);
                if (next !== null) {
                    value[i] = next;
                    changed = true;
                }
            } else if (rewriteDeep(item, rewrite)) {
                changed = true;
            }
        });
    } else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            const obj = value as Record<string, unknown>;
            const item = obj[key];
            if (typeof item === 'string') {
                const next = rewrite(item);
                if (next !== null) {
                    obj[key] = next;
                    changed = true;
                }
            } else if (rewriteDeep(item, rewrite)) {
                changed = true;
            }
        }
    }
    return changed;
}

export const legacyTagMigrationService = new LegacyTagMigrationService();
