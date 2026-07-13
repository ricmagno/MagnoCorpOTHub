import { Router, Request, Response } from 'express';
import { authenticateToken } from '@/middleware/auth';
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { teveConfigService } from '@/services/teveConfigService';
import { apiLogger } from '@/utils/logger';

/**
 * Proxies browser requests through to the Tensor Historian / TEVE service, whose
 * location is admin-configured (see teveConfigService) rather than hardcoded — it's a
 * separate, optional service in its own container(s) that may not exist for a given
 * deployment. The browser only ever talks to this backend, same-origin, regardless of
 * where TEVE actually lives or whether it's reachable at all.
 *
 * @param upstreamPath Rewrites the forwarded path. Given the incoming request's path
 *   relative to this router's mount point, returns the path to call on TEVE.
 */
function createTeveProxy(upstreamPath: (reqPath: string) => string): Router {
  const router = Router();

  router.use(authenticateToken, asyncHandler(async (req: Request, res: Response) => {
    const baseUrl = teveConfigService.getActiveBaseUrl();
    if (!baseUrl) {
      throw createError('Tensor Historian is not configured or is disabled', 503);
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      throw createError('Method not allowed', 405);
    }

    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const url = `${baseUrl}${upstreamPath(req.path)}${qs}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const init: RequestInit = { method: req.method, signal: controller.signal };
      if (req.method === 'POST') {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(req.body ?? {});
      }
      const upstream = await fetch(url, init);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.set('Content-Type', contentType);
      const cacheControl = upstream.headers.get('cache-control');
      if (cacheControl) res.set('Cache-Control', cacheControl);

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status).send(buf);
    } catch (error: any) {
      const message = error?.name === 'AbortError' ? 'Tensor Historian request timed out' : String(error?.message ?? error);
      apiLogger.error('TEVE proxy request failed', { url, message });
      res.status(502).json({ error: message });
    } finally {
      clearTimeout(timeout);
    }
  }));

  return router;
}

export const teveApiProxy = createTeveProxy((path) => `/api/teve${path}`);
export const historianApiProxy = createTeveProxy((path) => `/api/historian${path}`);
export const teveGraphqlProxy = createTeveProxy(() => '/graphql');
