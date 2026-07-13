import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticateToken, requireRole } from '@/middleware/auth';

const requireAdmin = requireRole('admin');
import { asyncHandler, createError } from '@/middleware/errorHandler';
import { brandingService } from '@/services/brandingService';
import { apiLogger } from '@/utils/logger';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Public — used before login to render navbar
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const settings = brandingService.getSettings();
  res.json({ ...settings, hasLogo: brandingService.hasLogo() });
}));

// Serve logo image directly (public)
router.get('/logo', asyncHandler(async (_req: Request, res: Response) => {
  const logo = brandingService.getLogo();
  if (!logo) throw createError('No logo configured', 404);
  const match = logo.match(/^data:([^;]+);base64,(.+)$/);
  if (!match || !match[1] || !match[2]) throw createError('Invalid logo data', 500);
  res.set('Content-Type', match[1]);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(match[2], 'base64'));
}));

// Admin: update text settings
router.put('/', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { companyName, appName, siteName, primaryColor, accentColor, website, reportFooter, emailSenderName } = req.body;
  const updated = brandingService.updateSettings({ companyName, appName, siteName, primaryColor, accentColor, website, reportFooter, emailSenderName });
  apiLogger.info('Branding settings updated', { userId: req.user?.id });
  res.json({ ...updated, hasLogo: brandingService.hasLogo() });
}));

// Admin: upload logo
router.post('/logo', authenticateToken, requireAdmin, upload.single('logo'), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw createError('No file uploaded', 400);
  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  brandingService.setLogo(dataUrl);
  apiLogger.info('Branding logo updated', { userId: req.user?.id, bytes: req.file.size });
  res.json({ hasLogo: true });
}));

// Admin: remove logo
router.delete('/logo', authenticateToken, requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  brandingService.setLogo('');
  res.json({ hasLogo: false });
}));

export default router;
