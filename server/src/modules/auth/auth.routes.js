import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { auditContext } from '../../lib/audit.js';
import { rotateRefreshToken, revokeRefreshToken, revokeAllForUser } from '../../lib/tokens.js';
import { publicUser } from './auth.service.js';
import * as service from './auth.service.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  updateMeSchema,
} from './auth.schemas.js';

const router = Router();

// Credential endpoints get a much tighter limit than the global /api one.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' },
  },
});

/** POST /api/auth/register - patient self-registration */
router.post(
  '/register',
  credentialLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.registerPatient(req.body, auditContext(req));
    res.status(201).json(result);
  })
);

/** POST /api/auth/login */
router.post(
  '/login',
  credentialLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.login(req.body, auditContext(req));
    res.json(result);
  })
);

/** POST /api/auth/refresh - rotates the refresh token */
router.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const { pair, user } = await rotateRefreshToken(req.body.refreshToken);
    res.json({ user: publicUser(user), tokens: pair });
  })
);

/** POST /api/auth/logout - revokes the presented refresh token */
router.post(
  '/logout',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    await revokeRefreshToken(req.body.refreshToken);
    res.status(204).send();
  })
);

/** POST /api/auth/logout-all - revokes every session for the caller */
router.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeAllForUser(req.user.id);
    res.status(204).send();
  })
);

/** GET /api/auth/me */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.getMe(req.user.id));
  })
);

/** PATCH /api/auth/me */
router.patch(
  '/me',
  requireAuth,
  validate({ body: updateMeSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.updateMe(req.user.id, req.body));
  })
);

/** POST /api/auth/change-password */
router.post(
  '/change-password',
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    await service.changePassword(req.user.id, req.body, auditContext(req));
    res.status(204).send();
  })
);

export default router;
