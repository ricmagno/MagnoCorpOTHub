import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Bearer-token auth for TEVE admin/export endpoints.
 *
 * Fails CLOSED: if HISTORIAN_ADMIN_TOKEN is unset (or blank), every request is
 * rejected rather than falling back to a shared default value. A default token
 * baked into the image would be identical across every deployment and is published
 * in this repo's docs, so "no token configured" must mean "no access", not
 * "access with the well-known token".
 *
 * The comparison is constant-time (crypto.timingSafeEqual) so the token cannot be
 * recovered a byte at a time via response-timing differences.
 */
function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; the length check itself leaks only
  // the token's length, which is not sensitive.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.HISTORIAN_ADMIN_TOKEN ?? '';
  if (!expected) {
    // Misconfiguration, not an auth failure — surface it distinctly so operators
    // know the endpoint is disabled until they set the secret.
    res.status(503).json({
      error: 'Admin endpoints are disabled: HISTORIAN_ADMIN_TOKEN is not configured on this server.',
    });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || !safeEqual(token, expected)) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing admin token' });
    return;
  }

  next();
}
