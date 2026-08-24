import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ForbiddenError, ConflictError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { utcFromLocal, addDaysToKey, dateKey } from '../../lib/time.js';
import { logger } from '../../lib/logger.js';

const log = logger.child('visit-notes');

/**
 * Wall-clock dose times per frequency, in the clinic timezone.
 *
 * Reminders are MATERIALISED as one row per dose when the prescription is
 * saved, rather than computed at send time from a recurrence rule. That costs a
 * few hundred rows but buys three things the rule-based approach cannot: each
 * dose can be individually retried or cancelled, "did we already send this?" is
 * a primary-key lookup instead of a date calculation, and a worker outage
 * cannot silently skip doses - they simply send late.
 */
const DOSE_TIMES = {
  ONCE_DAILY: { times: ['09:00'], everyNDays: 1 },
  TWICE_DAILY: { times: ['09:00', '21:00'], everyNDays: 1 },
  THRICE_DAILY: { times: ['08:00', '14:00', '20:00'], everyNDays: 1 },
  FOUR_TIMES_DAILY: { times: ['06:00', '12:00', '18:00', '22:00'], everyNDays: 1 },
  EVERY_OTHER_DAY: { times: ['09:00'], everyNDays: 2 },
  WEEKLY: { times: ['09:00'], everyNDays: 7 },
  AS_NEEDED: { times: [], everyNDays: 1 }, // no schedule to remind against
};

/** Rows one prescription item may generate, to bound a typo like 3650 days. */
const MAX_REMINDERS_PER_ITEM = 120;

export function buildReminderTimes({ frequency, durationDays, startDate }) {
  const plan = DOSE_TIMES[frequency];
  if (!plan || plan.times.length === 0) return [];

  const startKey = dateKey(startDate, 'UTC');
  const out = [];

  for (let day = 0; day < durationDays; day += plan.everyNDays) {
    const key = addDaysToKey(startKey, day);
    for (const t of plan.times) {
      out.push(utcFromLocal(key, t));
      if (out.length >= MAX_REMINDERS_PER_ITEM) return out;
    }
  }
  return out;
}

export const timesPerDayFor = (frequency) => DOSE_TIMES[frequency]?.times.length ?? 1;

/**
 * The doctor submits notes and a prescription after the consultation.
 *
 * One transaction covers: the visit note, its prescription items, every
 * medication reminder derived from them, and flipping the appointment to
 * COMPLETED. The post-visit summary row is created PENDING for the worker to
 * fill in - generation is NOT awaited here, because a 14-second model call
 * inside the doctor's save request would be unusable.
 */
export async function submitVisitNote(appointmentId, user, input, ctx = {}) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { visitNote: true, patient: true },
  });
  if (!appointment) throw new NotFoundError('Appointment');

  const isOwningDoctor = user.doctorId && appointment.doctorId === user.doctorId;
  if (!isOwningDoctor && user.role !== 'ADMIN') {
    throw new ForbiddenError('Only the attending doctor can submit visit notes');
  }
  if (appointment.visitNote) {
    throw new ConflictError('Visit notes have already been submitted for this appointment');
  }
  if (!['CONFIRMED', 'COMPLETED'].includes(appointment.status)) {
    throw new ConflictError(
      `Cannot submit notes for an appointment in status ${appointment.status}`
    );
  }

  const prescriptions = input.prescriptions ?? [];

  const result = await prisma.$transaction(async (tx) => {
    const note = await tx.visitNote.create({
      data: {
        appointmentId,
        doctorId: appointment.doctorId,
        clinicalNotes: input.clinicalNotes,
        diagnosis: input.diagnosis ?? null,
        advice: input.advice ?? null,
        followUpDate: input.followUpDate ?? null,
      },
    });

    let reminderCount = 0;

    for (const p of prescriptions) {
      const startDate = p.startDate ?? new Date();
      const item = await tx.prescriptionItem.create({
        data: {
          visitNoteId: note.id,
          medicationName: p.medicationName,
          dosage: p.dosage,
          frequency: p.frequency,
          timesPerDay: timesPerDayFor(p.frequency),
          durationDays: p.durationDays,
          startDate,
          instructions: p.instructions ?? null,
        },
      });

      const times = buildReminderTimes({
        frequency: p.frequency,
        durationDays: p.durationDays,
        startDate,
      });

      // Doses already in the past are recorded as CANCELLED rather than
      // skipped, so the schedule stays a complete record of what was intended.
      const now = new Date();
      const rows = times.map((scheduledAt) => ({
        prescriptionItemId: item.id,
        patientId: appointment.patientId,
        scheduledAt,
        status: scheduledAt < now ? 'CANCELLED' : 'PENDING',
      }));

      if (rows.length) {
        await tx.medicationReminder.createMany({ data: rows });
        reminderCount += rows.filter((r) => r.status === 'PENDING').length;
      }
    }

    await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: 'COMPLETED' },
    });

    // Picked up by the summary worker; not generated inline.
    await tx.postVisitSummary.upsert({
      where: { appointmentId },
      update: { status: 'PENDING', attempts: 0, lastError: null },
      create: { appointmentId, status: 'PENDING' },
    });

    return { note, reminderCount };
  });

  await audit({
    ...ctx,
    action: 'visit_note.submitted',
    entityType: 'VisitNote',
    entityId: result.note.id,
    metadata: {
      appointmentId,
      prescriptionItems: prescriptions.length,
      remindersScheduled: result.reminderCount,
    },
  });

  log.info('visit notes submitted', {
    appointmentId,
    prescriptions: prescriptions.length,
    reminders: result.reminderCount,
  });

  return {
    visitNote: result.note,
    remindersScheduled: result.reminderCount,
    postVisitSummary: { status: 'PENDING' },
  };
}
