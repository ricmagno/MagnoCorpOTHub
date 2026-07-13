import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, requireRole } from '@/middleware/auth';
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { identityProviderService } from '@/services/identityProviderService';
import { LdapProvider } from '@/services/identity/LdapProvider';
import { apiLogger } from '@/utils/logger';

const requireAdmin = requireRole('admin');
const router = Router();

const idParamSchema = z.enum(['ldap', 'oidc']);

const ldapConfigSchema = z.object({
  url: z.string().min(1),
  bindDn: z.string().min(1),
  bindPassword: z.string(),
  baseDn: z.string().min(1),
  userFilter: z.string().min(1),
  tlsRejectUnauthorized: z.boolean(),
  caCert: z.string().default('')
}).partial();

const oidcConfigSchema = z.object({
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string(),
  scopes: z.string().min(1)
}).partial();

// Never `admin` — a JIT default of `admin` would let a compromised directory group escalate
// straight to app-admin.
const jitRoleSchema = z.enum(['user', 'view-only']).optional();

const ldapUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  defaultRole: jitRoleSchema,
  config: ldapConfigSchema.optional()
});

const oidcUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  defaultRole: jitRoleSchema,
  config: oidcConfigSchema.optional()
});

// Admin: list both providers' configs, with secrets masked — never send decrypted secrets to the client.
router.get('/', authenticateToken, requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, providers: identityProviderService.listMaskedProviders() });
}));

// Admin: update one provider's config.
router.put('/:id', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const idResult = idParamSchema.safeParse(req.params.id);
  if (!idResult.success) throw createError('Unknown identity provider', 400);

  if (idResult.data === 'ldap') {
    const bodyResult = ldapUpdateSchema.safeParse(req.body);
    if (!bodyResult.success) throw createError('Invalid LDAP configuration', 400);
    identityProviderService.updateConfig('ldap', bodyResult.data);
  } else {
    const bodyResult = oidcUpdateSchema.safeParse(req.body);
    if (!bodyResult.success) throw createError('Invalid OIDC configuration', 400);
    identityProviderService.updateConfig('oidc', bodyResult.data);
  }

  apiLogger.info('Identity provider configuration updated', { id: idResult.data, userId: req.user?.id });
  res.json({ success: true, provider: identityProviderService.getMaskedConfig(idResult.data) });
}));

// Admin: test connectivity for a provider using its currently-saved config, without requiring
// a real end-user login.
router.post('/:id/test', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const idResult = idParamSchema.safeParse(req.params.id);
  if (!idResult.success) throw createError('Unknown identity provider', 400);

  if (idResult.data === 'ldap') {
    const record = identityProviderService.getConfig('ldap');
    if (!record) throw createError('LDAP is not configured yet', 400);
    const result = await new LdapProvider(record.config).testConnection();
    return res.json({ success: result.success, error: result.error });
  }

  // OIDC test-connection is added alongside the OIDC provider implementation.
  throw createError('Test connection is not yet implemented for this provider', 501);
}));

export default router;
