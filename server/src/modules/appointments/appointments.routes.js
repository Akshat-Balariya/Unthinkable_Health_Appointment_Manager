import { Router } from 'express';

import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { auditContext } from '../../lib/audit.js';
import { ForbiddenError } from '../../lib/errors.js';
import * as booking from './booking.service.js';
import {
  idParam,
  holdSlotSchema,
  confirmBookingSchema,
  cancelSchema,
  rescheduleSchema,
  listAppointmentsQuery,
} from './appointments.schemas.js';

const router = Router();
router.use(requireAuth);

/** Patients act as a patient; ensures the profile row actually exists. */
function requirePatientProfile(req, res, next) {
  if (req.user.role !== 'PATIENT' || !req.user.patientId) {
    return next(new ForbiddenError('Only patients can book appointments'));
  }
  next();
}

/**
 * POST /api/appointments/hold
 *
 * Step 1 of booking. Reserves the slot immediately with a TTL, so the patient
 * can fill in the symptom form without racing anyone else.
 */
router.post(
  '/hold',
  requirePatientProfile,
  validate({ body: holdSlotSchema }),
  asyncHandler(async (req, res) => {
    const held = await booking.holdSlot(
      {
        patientId: req.user.patientId,
        doctorId: req.body.doctorId,
        slotStart: req.body.slotStart,
        reasonForVisit: req.body.reasonForVisit,
      },
      auditContext(req)
    );
    res.status(201).json(held);
  })
);

/**
 * POST /api/appointments/:id/confirm
 *
 * Step 2 of booking: submit the symptom form and confirm the held slot.
 */
router.post(
  '/:id/confirm',
  requirePatientProfile,
  validate({ params: idParam, body: confirmBookingSchema }),
  asyncHandler(async (req, res) => {
    const confirmed = await booking.confirmBooking(
      req.params.id,
      req.user,
      req.body,
      auditContext(req)
    );
    res.json(confirmed);
  })
);

/** DELETE /api/appointments/:id/hold - give up a hold early */
router.delete(
  '/:id/hold',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await booking.releaseHold(req.params.id, req.user, auditContext(req)));
  })
);

/** GET /api/appointments - scoped to the caller's role */
router.get(
  '/',
  validate({ query: listAppointmentsQuery }),
  asyncHandler(async (req, res) => {
    res.json(await booking.listAppointments(req.user, req.validatedQuery));
  })
);

/** GET /api/appointments/:id */
router.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await booking.getAppointment(req.params.id, req.user));
  })
);

/** POST /api/appointments/:id/cancel - patient, doctor or admin */
router.post(
  '/:id/cancel',
  validate({ params: idParam, body: cancelSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await booking.cancelAppointment(req.params.id, req.user, req.body, auditContext(req))
    );
  })
);

/** POST /api/appointments/:id/reschedule */
router.post(
  '/:id/reschedule',
  validate({ params: idParam, body: rescheduleSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await booking.rescheduleAppointment(req.params.id, req.user, req.body, auditContext(req))
    );
  })
);

/** POST /api/appointments/expire-holds - manual sweeper trigger (admin) */
router.post(
  '/expire-holds',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const count = await booking.expireStaleHolds();
    res.json({ expired: count });
  })
);

export default router;
