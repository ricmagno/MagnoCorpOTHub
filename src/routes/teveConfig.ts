import { Router, Request, Response } from 'express';
import { authenticateToken, requireRole } from '@/middleware/auth';
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { teveConfigService } from '@/services/teveConfigService';
import { apiLogger } from '@/utils/logger';

const requireAdmin = requireRole('admin');
const router = Router();

// Authenticated (not admin-only): the Insights tab needs this to decide whether to
// render at all — TEVE is a separate, optional service that may not
// be deployed for a given customer.
router.get('/', authenticateToken, asyncHandler(async (_req: Request, res: Response) => {
  res.json(teveConfigService.getConfig());
}));

router.put('/', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { enabled, baseUrl } = req.body;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw createError('baseUrl must be a string', 400);
  }
  if (enabled === true && !(baseUrl ?? teveConfigService.getConfig().baseUrl)) {
    throw createError('baseUrl is required to enable the TEVE integration', 400);
  }
  const updated = teveConfigService.updateConfig({ enabled, baseUrl });
  apiLogger.info('TEVE config updated', { userId: req.user?.id, enabled: updated.enabled });
  res.json(updated);
}));

// Tests a CANDIDATE base URL (not necessarily the saved one) so admins can verify
// before saving, matching /api/database/test and /api/opcua/test-connection.
router.post('/test', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const baseUrl = String(req.body.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw createError('baseUrl is required', 400);

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const responseTime = Date.now() - started;
    if (!response.ok) {
      res.json({ success: false, message: `Historian service responded with ${response.status}`, responseTime });
      return;
    }
    res.json({ success: true, message: 'Connection successful', responseTime });
  } catch (error: any) {
    const responseTime = Date.now() - started;
    const message = error?.name === 'AbortError' ? 'Connection timed out after 5s' : String(error?.message ?? error);
    apiLogger.warn('TEVE connection test failed', { userId: req.user?.id, baseUrl, message });
    res.json({ success: false, message, responseTime });
  }
}));

export default router;
