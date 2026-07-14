import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { opcuaConfigService } from '@/services/opcuaConfigService';
import { opcuaManager } from '@/services/opcua/opcuaConnectionManager';
import { OpcuaConnection, getSharedCertificateManager } from '@/services/opcua/opcuaConnection';
import { legacyTagMigrationService } from '@/services/opcua/legacyTagMigrationService';
import { asyncHandler } from '@/middleware/errorHandler';
import { authenticateToken, requireRole } from '@/middleware/auth';
import { apiLogger } from '@/utils/logger';

const router = Router();

router.use(authenticateToken);

router.get('/configs', asyncHandler(async (req: Request, res: Response) => {
    const configs = await opcuaConfigService.listConfigurations();
    const health = new Map(opcuaManager.health().map(h => [h.id, h]));
    const legacyDefaultId = opcuaConfigService.getLegacyDefaultConnectionId();
    const data = configs.map(({ encryptedPassword, ...config }) => ({
        ...config,
        isLegacyDefault: config.id === legacyDefaultId,
        liveStatus: health.get(config.id)?.status ?? 'disconnected',
        lastError: health.get(config.id)?.lastError,
    }));
    res.json({ success: true, data });
}));

router.post('/configs', [
    requireRole('admin'),
    body('name').trim().notEmpty(),
    body('alias').optional().trim(),
    body('endpointUrl').trim().notEmpty(),
    body('securityMode').isIn(['None', 'Sign', 'SignAndEncrypt']),
    body('securityPolicy').isIn(['None', 'Basic128Rsa15', 'Basic256', 'Basic256Sha256']),
    body('authenticationMode').isIn(['Anonymous', 'Username']),
], asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const configId = await opcuaConfigService.saveConfiguration(req.body, req.user!.id);
    return res.status(201).json({ success: true, data: { id: configId } });
}));

// Tests a candidate config on a throwaway, unsupervised connection —
// never touches live connections or their subscriptions.
router.post('/test-connection', asyncHandler(async (req: Request, res: Response) => {
    apiLogger.info('Testing OPC UA connection...', { endpoint: req.body.endpointUrl });
    const probe = new OpcuaConnection(
        { ...req.body, name: req.body.name || 'test-probe' },
        getSharedCertificateManager(),
        false
    );
    try {
        await probe.start();
        res.json({ success: true, message: 'Connection successful' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    } finally {
        await probe.stop();
    }
}));

// connectionId (id or alias) selects the server; omitting it falls back to the
// legacy-default connection when one is designated.
router.get('/browse', asyncHandler(async (req: Request, res: Response) => {
    const nodeId = (req.query.nodeId as string) || 'RootFolder';
    const ref = req.query.connectionId as string | undefined;
    let connectionId: string | null;
    if (ref) {
        connectionId = opcuaManager.resolveConnectionRef(ref);
        if (!connectionId) {
            return res.status(404).json({ success: false, message: `Unknown OPC UA connection '${ref}'` });
        }
    } else {
        connectionId = opcuaManager.getLegacyDefaultConnectionId();
        if (!connectionId) {
            return res.status(400).json({
                success: false,
                message: 'connectionId is required (no legacy-default connection is designated)'
            });
        }
    }
    const tags = await opcuaManager.browse(connectionId, nodeId);
    return res.json({ success: true, data: tags });
}));

// Runtime status of all live connections (for the configuration UI).
router.get('/connections', asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: opcuaManager.health() });
}));

router.post('/configs/:id/enable', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    await opcuaConfigService.setEnabled(id, true);
    res.json({ success: true, message: 'Connection enabled' });
}));

router.post('/configs/:id/disable', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    await opcuaConfigService.setEnabled(id, false);
    res.json({ success: true, message: 'Connection disabled' });
}));

// Explicit opt-in for the legacy unqualified-tag fallback (off by default).
router.post('/configs/:id/legacy-default', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    await opcuaConfigService.setLegacyDefaultConnection(id);
    res.json({ success: true, message: 'Legacy-default connection set' });
}));

router.delete('/legacy-default', requireRole('admin'), asyncHandler(async (_req: Request, res: Response) => {
    await opcuaConfigService.setLegacyDefaultConnection(null);
    res.json({ success: true, message: 'Legacy-default connection cleared' });
}));

// One-shot migration: rewrites stored unqualified opcua:<nodeId> tags (alert
// configs, TEVE historize tags, report/dashboard configs) to the qualified
// form bound to the given connection. Idempotent. Pass dryRun: true for a
// no-write preview with counts and sample rewrites.
router.post('/migrate-legacy-tags', [
    requireRole('admin'),
    body('connectionId').trim().notEmpty(),
    body('dryRun').optional().isBoolean(),
], asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const result = await legacyTagMigrationService.migrate(req.body.connectionId, req.body.dryRun === true);
    return res.json({ success: true, data: result });
}));

/** @deprecated one-release alias: enable + connect (does NOT touch the legacy default). */
router.post('/activate/:id', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    apiLogger.warn('POST /api/opcua/activate/:id is deprecated — use /configs/:id/enable');
    await opcuaConfigService.setEnabled(id, true);
    return res.json({ success: true, message: 'Configuration activated' });
}));

router.delete('/configs/:id', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        apiLogger.info(`Deleting OPC UA configuration: ${id}`);
        const unbound = await opcuaConfigService.deleteConfiguration(id);
        res.json({ success: true, message: 'Configuration deleted', data: unbound });
    } catch (error: any) {
        apiLogger.error(`Failed to delete OPC UA configuration: ${req.params.id}`, error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
}));

export default router;
