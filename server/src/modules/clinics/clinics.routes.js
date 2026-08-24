import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { auditContext } from '../../lib/audit.js';
import { ForbiddenError } from '../../lib/errors.js';
import { passwordSchema, emailSchema } from '../auth/auth.schemas.js';
import * as clinics from './clinics.service.js';

const router = Router();

const registerClinicSchema = z.object({
  name: z.string().trim().min(2, 'Clinic name is required').max(160),
  clinicEmail: emailSchema,
  phone: z.string().trim().max(32).optional(),
  addressLine: z.string().trim().max(240).optional(),
  city: z.string().trim().max(80).optional(),
  timezone: z.string().max(64).optional(),

  adminName: z.string().trim().min(2, 'Administrator name is required').max(120),
  adminEmail: emailSchema,
  password: passwordSchema,
});

const updateClinicSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    addressLine: z.string().trim().max(240).nullable().optional(),
    city: z.string().trim().max(80).nullable().optional(),
    timezone: z.string().max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const registerLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many clinic registrations. Try again later.' },
  },
});

/**
 * POST /api/clinics/register
 * Public self-service signup. Creates the clinic and its first CLINIC_ADMIN.
 */
router.post(
  '/register',
  registerLimiter,
  validate({ body: registerClinicSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await clinics.registerClinic(req.body, auditContext(req)));
  })
);

/** GET /api/clinics - public directory, used by the patient search filter */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await clinics.listClinics());
  })
);

/** GET /api/clinics/me - the signed-in clinic admin's own clinic */
router.get(
  '/me',
  requireAuth,
  requireRole('CLINIC_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!req.user.clinicId) throw new ForbiddenError('This account is not linked to a clinic');
    res.json(await clinics.getClinic(req.user.clinicId));
  })
);

/** PATCH /api/clinics/me */
router.patch(
  '/me',
  requireAuth,
  requireRole('CLINIC_ADMIN'),
  validate({ body: updateClinicSchema }),
  asyncHandler(async (req, res) => {
    if (!req.user.clinicId) throw new ForbiddenError('This account is not linked to a clinic');
    res.json(await clinics.updateClinic(req.user.clinicId, req.body, auditContext(req)));
  })
);

export default router;
