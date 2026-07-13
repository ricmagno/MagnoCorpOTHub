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
  const { nodeId, tagName, unit } = req.body;
  if (!nodeId || typeof nodeId !== 'string') throw createError('nodeId is required', 400);
  if (!tagName || typeof tagName !== 'string') throw createError('tagName is required', 400);
  teveTagConfigService.add(nodeId, tagName, unit);
  apiLogger.info('TEVE historize tag added', { userId: req.user?.id, nodeId, tagName });
  res.status(201).json(teveTagConfigService.list());
}));

router.delete('/:nodeId', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const nodeId = req.params.nodeId;
  if (!nodeId) throw createError('nodeId is required', 400);
  teveTagConfigService.remove(nodeId);
  apiLogger.info('TEVE historize tag removed', { userId: req.user?.id, nodeId });
  res.json(teveTagConfigService.list());
}));

export default router;
