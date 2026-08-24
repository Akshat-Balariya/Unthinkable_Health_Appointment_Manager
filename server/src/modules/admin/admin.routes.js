import { Router } from 'express';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { auditContext } from '../../lib/audit.js';
import * as doctors from './doctors.service.js';
import {
  createDoctorSchema,
  updateDoctorSchema,
  replaceWorkingHoursSchema,
  createLeaveSchema,
  listDoctorsQuery,
  idParam,
  doctorLeaveParams,
} from './admin.schemas.js';

const router = Router();

/** Restricts a listing to the caller's clinic; platform admins stay unscoped. */
const scopeOf = (req) =>
  req.user.role === 'CLINIC_ADMIN' ? { clinicId: req.user.clinicId } : {};

// Doctor management is available to a clinic's own admin and to platform
// admins. Every handler passes auditContext(req), whose clinicId confines a
// CLINIC_ADMIN to its own doctors.
router.use(requireAuth, requireRole('ADMIN', 'CLINIC_ADMIN'));

// --- doctors ---------------------------------------------------------------

/** POST /api/admin/doctors */
router.post(
  '/doctors',
  validate({ body: createDoctorSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await doctors.createDoctor(req.body, auditContext(req)));
  })
);

/** GET /api/admin/doctors?specialisation=&q=&isActive=&page=&limit= */
router.get(
  '/doctors',
  validate({ query: listDoctorsQuery }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.listDoctors({ ...req.validatedQuery, ...scopeOf(req) }));
  })
);

/** GET /api/admin/doctors/:id */
router.get(
  '/doctors/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.getDoctor(req.params.id, auditContext(req)));
  })
);

/** PATCH /api/admin/doctors/:id */
router.patch(
  '/doctors/:id',
  validate({ params: idParam, body: updateDoctorSchema }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.updateDoctor(req.params.id, req.body, auditContext(req)));
  })
);

/** DELETE /api/admin/doctors/:id - deactivates, never hard-deletes */
router.delete(
  '/doctors/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.deactivateDoctor(req.params.id, auditContext(req)));
  })
);

// --- working hours ---------------------------------------------------------

/** PUT /api/admin/doctors/:id/working-hours - replaces the weekly schedule */
router.put(
  '/doctors/:id/working-hours',
  validate({ params: idParam, body: replaceWorkingHoursSchema }),
  asyncHandler(async (req, res) => {
    const updated = await doctors.replaceWorkingHours(
      req.params.id,
      req.body.workingHours,
      auditContext(req)
    );
    res.json(updated);
  })
);

// --- leave -----------------------------------------------------------------

/**
 * POST /api/admin/doctors/:id/leaves/preview
 * Dry run: reports which appointments a leave would cancel, writing nothing.
 */
router.post(
  '/doctors/:id/leaves/preview',
  validate({ params: idParam, body: createLeaveSchema }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.previewLeaveConflicts(req.params.id, req.body, auditContext(req)));
  })
);

/** POST /api/admin/doctors/:id/leaves - creates the leave and cascades */
router.post(
  '/doctors/:id/leaves',
  validate({ params: idParam, body: createLeaveSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await doctors.createLeave(req.params.id, req.body, auditContext(req)));
  })
);

/** GET /api/admin/doctors/:id/leaves?from=&to= */
router.get(
  '/doctors/:id/leaves',
  validate({
    params: idParam,
    query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.listLeaves(req.params.id, req.validatedQuery, auditContext(req)));
  })
);

/** DELETE /api/admin/doctors/:id/leaves/:leaveId */
router.delete(
  '/doctors/:id/leaves/:leaveId',
  validate({ params: doctorLeaveParams }),
  asyncHandler(async (req, res) => {
    res.json(await doctors.deleteLeave(req.params.id, req.params.leaveId, auditContext(req)));
  })
);

export default router;
