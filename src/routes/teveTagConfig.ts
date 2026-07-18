import { Router, Request, Response } from 'express';
import { authenticateToken, requireRole } from '@/middleware/auth';
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { teveTagConfigService } from '@/services/teveTagConfigService';
import { opcuaConfigService } from '@/services/opcuaConfigService';
import { apiLogger } from '@/utils/logger';

const requireAdmin = requireRole('admin');
const router = Router();

const EXPORT_SCHEMA_VERSION = 1;

interface TeveTagExportFile {
  version: number;
  exportedAt: string;
  tags: Array<{ connectionAlias: string | null; nodeId: string; tagName: string; unit: string | null; enabled: boolean }>;
}

router.get('/', authenticateToken, asyncHandler(async (_req: Request, res: Response) => {
  res.json(teveTagConfigService.list());
}));

router.post('/', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { nodeId, tagName, unit, connectionId } = req.body;
  if (!nodeId || typeof nodeId !== 'string') throw createError('nodeId is required', 400);
  if (!tagName || typeof tagName !== 'string') throw createError('tagName is required', 400);
  if (connectionId !== undefined && connectionId !== null && typeof connectionId !== 'string') {
    throw createError('connectionId must be a string', 400);
  }
  teveTagConfigService.add(nodeId, tagName, unit, connectionId ?? null);
  apiLogger.info('TEVE historize tag added', { userId: req.user?.id, nodeId, tagName, connectionId });
  res.status(201).json(teveTagConfigService.list());
}));

// Exported by connection ALIAS, not internal DB id — aliases are admin-chosen and
// stable, while ids are generated per-install and won't match across environments
// (e.g. exporting from dev and importing into prod).
router.get('/export', authenticateToken, asyncHandler(async (_req: Request, res: Response) => {
  const tags = teveTagConfigService.list();
  const connections = await opcuaConfigService.listConfigurations();
  const aliasById = new Map(connections.map((c) => [c.id, c.alias]));

  const file: TeveTagExportFile = {
    version: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tags: tags.map((t) => ({
      connectionAlias: t.connectionId ? aliasById.get(t.connectionId) ?? t.connectionId : null,
      nodeId: t.nodeId,
      tagName: t.tagName,
      unit: t.unit,
      enabled: t.enabled,
    })),
  };

  const filename = `teve-tags-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(JSON.stringify(file, null, 2));
}));

// Foreseen error handled explicitly: an imported tag's connectionAlias may not exist
// in this environment (different install, or the connection was never created here).
// Such rows are skipped with a warning rather than failing the whole import — the
// rest of the file still applies, and the admin can add the missing connection and
// re-import (add() is an upsert, so re-importing is idempotent).
router.post('/import', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { fileContent } = req.body;
  if (!fileContent || typeof fileContent !== 'string') {
    throw createError('File content is required and must be a string', 400);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    throw createError('File is not valid JSON', 400);
  }
  if (!parsed || !Array.isArray(parsed.tags)) {
    throw createError('Invalid TEVE tag export file: expected a "tags" array', 400);
  }

  const connections = await opcuaConfigService.listConfigurations();
  const idByAlias = new Map(connections.map((c) => [c.alias, c.id]));

  const errors: string[] = [];
  const warnings: string[] = [];
  let imported = 0;

  parsed.tags.forEach((entry: any, index: number) => {
    const label = `Row ${index + 1}`;
    if (!entry || typeof entry !== 'object') { errors.push(`${label}: not a valid tag entry`); return; }
    const { nodeId, tagName, unit, connectionAlias, enabled } = entry;
    if (!nodeId || typeof nodeId !== 'string') { errors.push(`${label}: missing nodeId`); return; }
    if (!tagName || typeof tagName !== 'string') { errors.push(`${label}: missing tagName`); return; }
    if (unit !== undefined && unit !== null && typeof unit !== 'string') {
      errors.push(`${label} (${tagName}): unit must be a string`);
      return;
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push(`${label} (${tagName}): enabled must be a boolean`);
      return;
    }

    let connectionId: string | null = null;
    if (connectionAlias !== undefined && connectionAlias !== null) {
      if (typeof connectionAlias !== 'string') {
        errors.push(`${label} (${tagName}): connectionAlias must be a string`);
        return;
      }
      const resolved = idByAlias.get(connectionAlias);
      if (!resolved) {
        warnings.push(`${label} (${tagName}): connection "${connectionAlias}" does not exist in this environment — skipped. Add the connection first, then re-import.`);
        return;
      }
      connectionId = resolved;
    }

    teveTagConfigService.add(nodeId, tagName, unit || null, connectionId);
    // enabled defaults to true on new rows via the column's DEFAULT; only make an
    // explicit follow-up call when the file says disabled, so re-importing a file that
    // omits `enabled` (or says true) never clobbers a disable set separately since export.
    if (enabled === false) {
      teveTagConfigService.setEnabled(nodeId, connectionId, false);
    }
    imported++;
  });

  apiLogger.info('TEVE historize tags imported', {
    userId: req.user?.id,
    imported,
    skipped: warnings.length,
    errors: errors.length,
  });
  res.json({ success: errors.length === 0, imported, skipped: warnings.length, errors, warnings, tags: teveTagConfigService.list() });
}));

router.patch('/:nodeId', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const nodeId = req.params.nodeId;
  if (!nodeId) throw createError('nodeId is required', 400);
  const connectionId = (req.query.connectionId as string | undefined) ?? null;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') throw createError('enabled must be a boolean', 400);
  teveTagConfigService.setEnabled(nodeId, connectionId, enabled);
  apiLogger.info('TEVE historize tag enabled state changed', { userId: req.user?.id, nodeId, connectionId, enabled });
  res.json(teveTagConfigService.list());
}));

router.delete('/:nodeId', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const nodeId = req.params.nodeId;
  if (!nodeId) throw createError('nodeId is required', 400);
  const connectionId = (req.query.connectionId as string | undefined) ?? null;
  teveTagConfigService.remove(nodeId, connectionId);
  apiLogger.info('TEVE historize tag removed', { userId: req.user?.id, nodeId, connectionId });
  res.json(teveTagConfigService.list());
}));

export default router;
