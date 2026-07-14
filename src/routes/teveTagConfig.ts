import { Router, Request, Response } from 'express';
import { authenticateToken, requireRole } from '@/middleware/auth';
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { teveTagConfigService } from '@/services/teveTagConfigService';
import { apiLogger } from '@/utils/logger';

const requireAdmin = requireRole('admin');
const router = Router();

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

router.delete('/:nodeId', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const nodeId = req.params.nodeId;
  if (!nodeId) throw createError('nodeId is required', 400);
  const connectionId = (req.query.connectionId as string | undefined) ?? null;
  teveTagConfigService.remove(nodeId, connectionId);
  apiLogger.info('TEVE historize tag removed', { userId: req.user?.id, nodeId, connectionId });
  res.json(teveTagConfigService.list());
}));

export default router;
