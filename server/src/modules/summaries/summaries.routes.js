import { Router } from 'express';

import { prisma } from '../../lib/prisma.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { auditContext } from '../../lib/audit.js';
import { NotFoundError, ForbiddenError } from '../../lib/errors.js';
import { submitVisitNote } from './visitNotes.service.js';
import {
  generatePreVisitSummary,
  generatePostVisitSummary,
} from './summaries.service.js';
import { idParam, submitVisitNoteSchema, regenerateSchema } from './summaries.schemas.js';

const router = Router();
router.use(requireAuth);

/** Loads an appointment and checks the caller is a participant. */
async function loadParticipantAppointment(appointmentId, user) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { id: true, doctorId: true, patientId: true },
  });
  if (!appt) throw new NotFoundError('Appointment');

  if (user.role === 'ADMIN') return { appt, viewer: 'ADMIN' };
  if (user.doctorId && appt.doctorId === user.doctorId) return { appt, viewer: 'DOCTOR' };
  if (user.patientId && appt.patientId === user.patientId) return { appt, viewer: 'PATIENT' };
  throw new ForbiddenError('You are not a participant in this appointment');
}

/**
 * GET /api/appointments/:id/pre-visit-summary  (doctor + admin only)
 *
 * Clinical triage written for a clinician. Deliberately not exposed to the
 * patient: an "urgency: HIGH" label with nobody to interpret it causes harm.
 */
router.get(
  '/:id/pre-visit-summary',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { viewer } = await loadParticipantAppointment(req.params.id, req.user);
    if (viewer === 'PATIENT') {
      throw new ForbiddenError('The pre-visit summary is only visible to your doctor');
    }

    const summary = await prisma.preVisitSummary.findUnique({
      where: { appointmentId: req.params.id },
      include: { appointment: { include: { symptomReport: true } } },
    });
    if (!summary) throw new NotFoundError('Pre-visit summary');

    res.json({
      status: summary.status,
      urgencyLevel: summary.urgencyLevel,
      chiefComplaint: summary.chiefComplaint,
      suggestedQuestions: summary.suggestedQuestions,
      generatedAt: summary.generatedAt,
      provider: summary.provider,
      model: summary.model,
      promptVersion: summary.promptVersion,
      attempts: summary.attempts,
      lastError: summary.status === 'FAILED' ? summary.lastError : null,
      // Always returned, so the doctor is never left with nothing when the
      // model is unavailable.
      symptomReport: summary.appointment?.symptomReport ?? null,
    });
  })
);

/** GET /api/appointments/:id/post-visit-summary - patient-facing */
router.get(
  '/:id/post-visit-summary',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await loadParticipantAppointment(req.params.id, req.user);

    const summary = await prisma.postVisitSummary.findUnique({
      where: { appointmentId: req.params.id },
    });
    if (!summary) throw new NotFoundError('Post-visit summary');

    res.json({
      status: summary.status,
      patientFriendlyText: summary.patientFriendlyText,
      medicationSchedule: summary.medicationSchedule,
      followUpSteps: summary.followUpSteps,
      warningSigns: summary.warningSigns,
      generatedAt: summary.generatedAt,
      provider: summary.provider,
      model: summary.model,
      attempts: summary.attempts,
      lastError: summary.status === 'FAILED' ? summary.lastError : null,
    });
  })
);

/** POST /api/appointments/:id/visit-note - doctor submits notes + prescription */
router.post(
  '/:id/visit-note',
  validate({ params: idParam, body: submitVisitNoteSchema }),
  asyncHandler(async (req, res) => {
    const result = await submitVisitNote(
      req.params.id,
      req.user,
      req.body,
      auditContext(req)
    );
    res.status(201).json(result);
  })
);

/**
 * POST /api/appointments/:id/pre-visit-summary/regenerate
 * Manual retry for a summary that failed. Doctors and admins only.
 */
router.post(
  '/:id/pre-visit-summary/regenerate',
  requireRole('DOCTOR', 'ADMIN'),
  validate({ params: idParam, body: regenerateSchema }),
  asyncHandler(async (req, res) => {
    await loadParticipantAppointment(req.params.id, req.user);
    res.json(await generatePreVisitSummary(req.params.id, { force: req.body.force }));
  })
);

/** POST /api/appointments/:id/post-visit-summary/regenerate */
router.post(
  '/:id/post-visit-summary/regenerate',
  requireRole('DOCTOR', 'ADMIN'),
  validate({ params: idParam, body: regenerateSchema }),
  asyncHandler(async (req, res) => {
    await loadParticipantAppointment(req.params.id, req.user);
    res.json(await generatePostVisitSummary(req.params.id, { force: req.body.force }));
  })
);

export default router;
