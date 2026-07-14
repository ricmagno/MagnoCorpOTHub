import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opcua-migration-test-'));

jest.mock('@/config/environment', () => ({
    getDatabasePath: jest.fn((name: string) => path.join(tmpDir, name)),
    env: {
        OPCUA_MAX_CONNECTIONS: 64,
        OPCUA_CONNECT_CONCURRENCY: 5,
        OPCUA_QUARANTINE_AFTER_CYCLES: 5,
        OPCUA_QUARANTINE_MS: 900_000,
    },
}));

jest.mock('@/utils/logger', () => ({
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    apiLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/services/opcuaConfigService', () => ({
    opcuaConfigService: {
        listConfigurations: jest.fn().mockResolvedValue([
            { id: 'conn-1', alias: 'kepserver', name: 'KEPServerEX' },
            { id: 'conn-2', alias: 'plc-2', name: 'PLC 2' },
        ]),
    },
}));

jest.mock('@/services/alertManagementService', () => ({
    alertManagementService: {
        assignConnectionToUnqualified: jest.fn().mockReturnValue(2),
        countUnqualified: jest.fn().mockReturnValue(2),
        clearConnectionReferences: jest.fn(),
    },
}));

jest.mock('@/services/teveTagConfigService', () => ({
    teveTagConfigService: {
        assignConnectionToUnqualified: jest.fn().mockReturnValue(1),
        countUnqualified: jest.fn().mockReturnValue(1),
        clearConnectionReferences: jest.fn(),
    },
}));

import { legacyTagMigrationService } from '../opcua/legacyTagMigrationService';

function seedReportsDb(): void {
    const db = new Database(path.join(tmpDir, 'reports.db'));
    db.exec(`
        CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, config JSON NOT NULL);
        CREATE TABLE IF NOT EXISTS report_versions (id TEXT PRIMARY KEY, config JSON NOT NULL);
        DELETE FROM reports; DELETE FROM report_versions;
    `);
    const insert = db.prepare('INSERT INTO reports (id, config) VALUES (?, ?)');
    insert.run('r1', JSON.stringify({
        name: 'Mixed tags',
        tags: ['ReactorTemp', 'opcua:ns=2;s=Line1.PV', 'opcua:plc-2:ns=3;i=42', 'tensor:sys.tag'],
    }));
    insert.run('r2', JSON.stringify({ name: 'No opcua', tags: ['OnlyHistorian'] }));
    db.prepare('INSERT INTO report_versions (id, config) VALUES (?, ?)').run(
        'v1', JSON.stringify({ tags: ['opcua:ns=2;s=Old.PV'] })
    );
    db.close();
}

function readReportTags(id: string): string[] {
    const db = new Database(path.join(tmpDir, 'reports.db'));
    const row = db.prepare('SELECT config FROM reports WHERE id = ?').get(id) as any;
    db.close();
    return JSON.parse(row.config).tags;
}

describe('legacyTagMigrationService', () => {
    beforeEach(() => {
        seedReportsDb();
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects unknown connections', async () => {
        await expect(legacyTagMigrationService.migrate('nope')).rejects.toThrow('Configuration not found');
    });

    it('dry run counts and samples without writing anything', async () => {
        const result = await legacyTagMigrationService.migrate('conn-1', true);

        expect(result.dryRun).toBe(true);
        expect(result.alertConfigs).toBe(2);
        expect(result.teveHistorizeTags).toBe(1);
        expect(result.reports).toBe(1);
        expect(result.reportVersions).toBe(1);
        expect(result.samples).toEqual(expect.arrayContaining([
            { store: 'reports', from: 'opcua:ns=2;s=Line1.PV', to: 'opcua:kepserver:ns=2;s=Line1.PV' },
        ]));

        // Nothing was persisted.
        expect(readReportTags('r1')).toContain('opcua:ns=2;s=Line1.PV');
        const { alertManagementService } = require('@/services/alertManagementService');
        expect(alertManagementService.assignConnectionToUnqualified).not.toHaveBeenCalled();
    });

    it('rewrites only unqualified opcua tags, binding them to the target connection', async () => {
        const result = await legacyTagMigrationService.migrate('conn-1');

        expect(result.reports).toBe(1);
        expect(result.reportVersions).toBe(1);
        const tags = readReportTags('r1');
        expect(tags).toEqual([
            'ReactorTemp',                        // historian tag untouched
            'opcua:kepserver:ns=2;s=Line1.PV',    // legacy tag qualified
            'opcua:plc-2:ns=3;i=42',              // already qualified — untouched
            'tensor:sys.tag',                     // tensor tag untouched
        ]);

        const { alertManagementService } = require('@/services/alertManagementService');
        const { teveTagConfigService } = require('@/services/teveTagConfigService');
        expect(alertManagementService.assignConnectionToUnqualified).toHaveBeenCalledWith('conn-1');
        expect(teveTagConfigService.assignConnectionToUnqualified).toHaveBeenCalledWith('conn-1');
    });

    it('is idempotent: a second run changes nothing', async () => {
        await legacyTagMigrationService.migrate('conn-1');
        const second = await legacyTagMigrationService.migrate('conn-1');

        expect(second.reports).toBe(0);
        expect(second.reportVersions).toBe(0);
        expect(readReportTags('r1')).toContain('opcua:kepserver:ns=2;s=Line1.PV');
    });

    it('tolerates a missing dashboards.db', async () => {
        const result = await legacyTagMigrationService.migrate('conn-1');
        expect(result.dashboards).toBe(0);
        expect(result.dashboardVersions).toBe(0);
    });
});
