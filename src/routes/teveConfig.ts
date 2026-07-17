import { Router, Request, Response } from 'express';
import { authenticateToken, requireRole } from '@/middleware/auth';
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { teveConfigService } from '@/services/teveConfigService';
import { apiLogger } from '@/utils/logger';

const requireAdmin = requireRole('admin');
const router = Router();

/**
 * Node's fetch (undici) wraps network failures in a generic TypeError with the
 * actionable detail buried in `error.cause.code` — surfacing that raw would just
 * hand an admin an opaque "fetch failed". Categorize the common cases so a failed
 * test points at what to actually check next, not a Node internals error string.
 */
function diagnoseConnectionError(error: any, baseUrl: string): string {
  if (error?.name === 'AbortError') {
    return 'Connection timed out after 5s — the service did not respond in time. Check the URL and that the service is running and reachable from this server.';
  }

  const code = error?.cause?.code ?? error?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'DNS lookup failed — the hostname could not be resolved. Check it\'s spelled correctly and resolvable from this server (not just your browser).';
    case 'ECONNREFUSED':
      return 'Connection refused — the host was reached but nothing is listening on that port. Check the port number and that the service is running.';
    case 'ECONNRESET':
      return 'Connection reset by the remote host — the service may have crashed or closed the connection mid-request.';
    case 'CERT_HAS_EXPIRED':
      return 'TLS certificate has expired on the remote service.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate could not be verified (self-signed or untrusted CA) — either fix the certificate or use http:// if TLS isn\'t required for this deployment.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS certificate does not match the hostname in the URL.';
  }

  if (error instanceof TypeError && /invalid url/i.test(error.message ?? '')) {
    return `"${baseUrl}" is not a valid URL — check the format (e.g. http://host:port).`;
  }

  // Fall back to whatever Node actually said rather than hiding it entirely.
  return String(error?.message ?? error);
}

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
    const message = diagnoseConnectionError(error, baseUrl);
    apiLogger.warn('TEVE connection test failed', {
      userId: req.user?.id,
      baseUrl,
      message,
      code: error?.cause?.code ?? error?.code,
    });
    res.json({ success: false, message, responseTime });
  }
}));

export default router;
