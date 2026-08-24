import { prisma, isSlotConflict } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
  SlotUnavailableError,
} from '../../lib/errors.js';
import { assertSlotIsBookable } from './slots.service.js';
import { enqueueMany } from '../../lib/outbox.js';
import { audit } from '../../lib/audit.js';
import { formatForHuman } from '../../lib/time.js';
import { logger } from '../../lib/logger.js';

const log = logger.child('booking');

/** How many slots one patient may hold at once, to stop slot-squatting. */
const MAX_CONCURRENT_HOLDS = 3;

export const appointmentInclude = {
  doctor: {
    include: { user: { select: { id: true, email: true, fullName: true } } },
  },
  patient: {
    include: { user: { select: { id: true, email: true, fullName: true } } },
  },
};

export function shapeAppointment(a) {
  if (!a) return null;
  return {
    id: a.id,
    status: a.status,
    slotStart: a.slotStart,
    slotEnd: a.slotEnd,
    holdExpiresAt: a.holdExpiresAt,
    confirmedAt: a.confirmedAt,
    reasonForVisit: a.reasonForVisit,
    cancelReason: a.cancelReason,
    cancelledBy: a.cancelledBy,
    doctor: a.doctor
      ? {
          id: a.doctor.id,
          fullName: a.doctor.user.fullName,
          specialisation: a.doctor.specialisation,
          consultationFee: Number(a.doctor.consultationFee),
        }
      : undefined,
    patient: a.patient
      ? { id: a.patient.id, fullName: a.patient.user.fullName }
      : undefined,
    createdAt: a.createdAt,
  };
}

/**
 * Releases holds whose TTL has lapsed.
 *
 * A lapsed hold still occupies the partial unique index until its status
 * changes, so this must run before any insert that would collide with one -
 * not only on the background sweeper's schedule. Scoping it to a single slot
 * keeps that inline call cheap.
 */
export async function expireStaleHolds({ doctorId = null, slotStart = null } = {}) {
  const { count } = await prisma.appointment.updateMany({
    where: {
      status: 'HELD',
      holdExpiresAt: { lt: new Date() },
      ...(doctorId ? { doctorId } : {}),
      ...(slotStart ? { slotStart } : {}),
    },
    data: { status: 'EXPIRED' },
  });
  if (count > 0) log.info('expired stale holds', { count, doctorId: doctorId ?? 'all' });
  return count;
}

/**
 * Step 1 of booking: reserve the slot.
 *
 * The HELD row is written immediately, so it occupies the partial unique index
 * from this instant. That closes the window between "patient chose a slot" and
 * "patient finished the symptom form" - without it, two patients could both
 * complete the form believing the slot was theirs.
 *
 * Correctness does not depend on the pre-checks below. If two requests race,
 * both pass validation and both attempt the insert; Postgres rejects one and we
 * translate that into a 409.
 */
export async function holdSlot({ patientId, doctorId, slotStart, reasonForVisit }, ctx = {}) {
  const { doctor, slotEnd } = await assertSlotIsBookable(doctorId, slotStart);

  // A lapsed hold on this exact slot would otherwise block a legitimate booking
  // until the sweeper next ran.
  await expireStaleHolds({ doctorId, slotStart });

  const activeHolds = await prisma.appointment.count({
    where: { patientId, status: 'HELD', holdExpiresAt: { gt: new Date() } },
  });
  if (activeHolds >= MAX_CONCURRENT_HOLDS) {
    throw new ConflictError(
      `You already have ${activeHolds} slots on hold. Confirm or release one before holding another.`
    );
  }

  // A patient cannot be in two places at once, even with different doctors.
  const patientClash = await prisma.appointment.findFirst({
    where: {
      patientId,
      status: { in: ['HELD', 'CONFIRMED'] },
      slotStart: { lt: slotEnd },
      slotEnd: { gt: slotStart },
    },
  });
  if (patientClash) {
    throw new ConflictError('You already have an appointment that overlaps this time');
  }

  const holdExpiresAt = new Date(Date.now() + env.SLOT_HOLD_TTL_SECONDS * 1000);

  let appointment;
  try {
    appointment = await prisma.appointment.create({
      data: {
        doctorId,
        patientId,
        slotStart,
        slotEnd,
        status: 'HELD',
        holdExpiresAt,
        reasonForVisit: reasonForVisit ?? null,
      },
      include: appointmentInclude,
    });
  } catch (e) {
    // The database guard fired: somebody else took this slot first.
    if (isSlotConflict(e)) throw new SlotUnavailableError();
    throw e;
  }

  await audit({
    ...ctx,
    action: 'appointment.held',
    entityType: 'Appointment',
    entityId: appointment.id,
    metadata: { doctorId, slotStart: slotStart.toISOString() },
  });

  return {
    ...shapeAppointment(appointment),
    holdExpiresInSeconds: env.SLOT_HOLD_TTL_SECONDS,
  };
}

/** Voluntarily gives up a hold before its TTL expires. */
export async function releaseHold(appointmentId, user, ctx = {}) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw new NotFoundError('Appointment');
  if (appt.patientId !== user.patientId && user.role !== 'ADMIN') {
    throw new ForbiddenError('This hold belongs to another patient');
  }
  if (appt.status !== 'HELD') {
    throw new ConflictError(`Cannot release an appointment in status ${appt.status}`);
  }

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: 'EXPIRED' },
  });

  await audit({
    ...ctx,
    action: 'appointment.hold_released',
    entityType: 'Appointment',
    entityId: appointmentId,
  });

  return { id: appointmentId, status: 'EXPIRED' };
}

/**
 * Step 2 of booking: capture symptoms and confirm.
 *
 * Everything below happens in one transaction:
 *   - the symptom report is stored
 *   - the appointment flips HELD -> CONFIRMED
 *   - a PreVisitSummary row is created in PENDING (Part 4 fills it in)
 *   - confirmation emails for both parties are queued
 *   - the reminder is queued, dated to fire before the appointment
 *
 * The status guard in the update is what makes this safe against a concurrent
 * sweeper: `where: { id, status: 'HELD' }` fails rather than resurrecting an
 * appointment that just expired.
 */
export async function confirmBooking(appointmentId, user, symptoms, ctx = {}) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: appointmentInclude,
  });
  if (!appt) throw new NotFoundError('Appointment');
  if (appt.patientId !== user.patientId) {
    throw new ForbiddenError('This appointment belongs to another patient');
  }
  if (appt.status === 'CONFIRMED') {
    throw new ConflictError('This appointment is already confirmed');
  }
  if (appt.status !== 'HELD') {
    throw new ConflictError(`Cannot confirm an appointment in status ${appt.status}`);
  }
  if (appt.holdExpiresAt && appt.holdExpiresAt < new Date()) {
    // Reflect reality before reporting it.
    await prisma.appointment.updateMany({
      where: { id: appointmentId, status: 'HELD' },
      data: { status: 'EXPIRED' },
    });
    throw new ConflictError(
      'Your hold on this slot expired. Please pick a slot again.'
    );
  }

  const reminderAt = new Date(
    appt.slotStart.getTime() - env.APPOINTMENT_REMINDER_LEAD_MINUTES * 60_000
  );
  const when = formatForHuman(appt.slotStart);

  const confirmed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.appointment.updateMany({
      where: { id: appointmentId, status: 'HELD' },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), holdExpiresAt: null },
    });
    if (claimed.count === 0) {
      throw new ConflictError('Your hold on this slot expired. Please pick a slot again.');
    }

    await tx.symptomReport.upsert({
      where: { appointmentId },
      update: {
        symptomsText: symptoms.symptomsText,
        durationDays: symptoms.durationDays ?? null,
        severity: symptoms.severity ?? null,
        existingConditions: symptoms.existingConditions ?? null,
        currentMedications: symptoms.currentMedications ?? null,
        additionalNotes: symptoms.additionalNotes ?? null,
      },
      create: {
        appointmentId,
        symptomsText: symptoms.symptomsText,
        durationDays: symptoms.durationDays ?? null,
        severity: symptoms.severity ?? null,
        existingConditions: symptoms.existingConditions ?? null,
        currentMedications: symptoms.currentMedications ?? null,
        additionalNotes: symptoms.additionalNotes ?? null,
      },
    });

    // Part 4 fills this in asynchronously. Creating it PENDING here means the
    // doctor's UI can show "summary being prepared" rather than nothing at all.
    await tx.preVisitSummary.upsert({
      where: { appointmentId },
      update: { status: 'PENDING', attempts: 0, lastError: null },
      create: { appointmentId, status: 'PENDING' },
    });

    await enqueueMany(tx, [
      {
        type: 'BOOKING_CONFIRMATION',
        recipientUserId: appt.patient.user.id,
        recipientEmail: appt.patient.user.email,
        recipientName: appt.patient.user.fullName,
        subject: `Appointment confirmed - ${when}`,
        appointmentId,
        dedupeKey: `BOOKING_CONFIRMATION:${appointmentId}:patient`,
        payload: {
          patientName: appt.patient.user.fullName,
          doctorName: appt.doctor.user.fullName,
          specialisation: appt.doctor.specialisation,
          when,
          slotStart: appt.slotStart.toISOString(),
          slotEnd: appt.slotEnd.toISOString(),
        },
      },
      {
        type: 'BOOKING_CONFIRMATION',
        recipientUserId: appt.doctor.user.id,
        recipientEmail: appt.doctor.user.email,
        recipientName: appt.doctor.user.fullName,
        subject: `New appointment - ${when}`,
        appointmentId,
        dedupeKey: `BOOKING_CONFIRMATION:${appointmentId}:doctor`,
        payload: {
          doctorName: appt.doctor.user.fullName,
          patientName: appt.patient.user.fullName,
          when,
          slotStart: appt.slotStart.toISOString(),
          symptomsPreview: String(symptoms.symptomsText).slice(0, 200),
        },
      },
      {
        type: 'APPOINTMENT_REMINDER',
        recipientUserId: appt.patient.user.id,
        recipientEmail: appt.patient.user.email,
        recipientName: appt.patient.user.fullName,
        subject: `Reminder: appointment with ${appt.doctor.user.fullName}`,
        appointmentId,
        dedupeKey: `APPOINTMENT_REMINDER:${appointmentId}:patient`,
        // Held back until shortly before the appointment.
        notBefore: reminderAt > new Date() ? reminderAt : new Date(),
        payload: {
          patientName: appt.patient.user.fullName,
          doctorName: appt.doctor.user.fullName,
          when,
          slotStart: appt.slotStart.toISOString(),
        },
      },
    ]);

    // Queue calendar sync for both participants. Rows are created regardless of
    // whether either has connected Google - the sync job treats "not connected"
    // as a no-op, and connecting later backfills them.
    await tx.calendarEvent.createMany({
      data: [
        { appointmentId, userId: appt.patient.user.id },
        { appointmentId, userId: appt.doctor.user.id },
      ],
      skipDuplicates: true,
    });

    return tx.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude });
  });

  await audit({
    ...ctx,
    action: 'appointment.confirmed',
    entityType: 'Appointment',
    entityId: appointmentId,
    metadata: { doctorId: appt.doctorId },
  });

  log.info('appointment confirmed', { appointmentId, slotStart: appt.slotStart.toISOString() });
  return shapeAppointment(confirmed);
}

/** Who is allowed to act on an appointment, and in which role. */
function authorise(appt, user, action) {
  if (user.role === 'ADMIN') return 'ADMIN';
  if (user.patientId && appt.patientId === user.patientId) return 'PATIENT';
  if (user.doctorId && appt.doctorId === user.doctorId) return 'DOCTOR';
  throw new ForbiddenError(`You cannot ${action} this appointment`);
}

/**
 * Cancels an appointment and tells both sides.
 *
 * Queued-but-unsent reminders are superseded in the same transaction, so a
 * patient never receives "your appointment is tomorrow" for something that was
 * called off.
 */
export async function cancelAppointment(appointmentId, user, { reason } = {}, ctx = {}) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: appointmentInclude,
  });
  if (!appt) throw new NotFoundError('Appointment');

  const actor = authorise(appt, user, 'cancel');

  if (!['HELD', 'CONFIRMED'].includes(appt.status)) {
    throw new ConflictError(`Cannot cancel an appointment in status ${appt.status}`);
  }
  if (appt.slotStart < new Date() && actor === 'PATIENT') {
    throw new ConflictError('This appointment has already started');
  }

  const when = formatForHuman(appt.slotStart);

  const cancelled = await prisma.$transaction(async (tx) => {
    const claimed = await tx.appointment.updateMany({
      where: { id: appointmentId, status: { in: ['HELD', 'CONFIRMED'] } },
      data: {
        status: 'CANCELLED',
        cancelledBy: actor,
        cancelledAt: new Date(),
        cancelReason: reason ?? null,
        holdExpiresAt: null,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictError('This appointment was already changed by someone else');
    }

    await tx.notificationOutbox.updateMany({
      where: {
        appointmentId,
        status: { in: ['PENDING', 'FAILED'] },
        type: { in: ['APPOINTMENT_REMINDER', 'BOOKING_CONFIRMATION'] },
      },
      data: { status: 'CANCELLED' },
    });

    // Desired state is now ABSENT; re-queue so the sync job deletes the events.
    await tx.calendarEvent.updateMany({
      where: { appointmentId, status: { in: ['SYNCED', 'FAILED'] } },
      data: { status: 'PENDING', attempts: 0 },
    });

    await enqueueMany(tx, [
      {
        type: 'CANCELLATION',
        recipientUserId: appt.patient.user.id,
        recipientEmail: appt.patient.user.email,
        recipientName: appt.patient.user.fullName,
        subject: `Appointment cancelled - ${when}`,
        appointmentId,
        dedupeKey: `CANCELLATION:${appointmentId}:patient`,
        payload: {
          patientName: appt.patient.user.fullName,
          doctorName: appt.doctor.user.fullName,
          when,
          cancelledBy: actor,
          reason: reason ?? null,
        },
      },
      {
        type: 'CANCELLATION',
        recipientUserId: appt.doctor.user.id,
        recipientEmail: appt.doctor.user.email,
        recipientName: appt.doctor.user.fullName,
        subject: `Appointment cancelled - ${when}`,
        appointmentId,
        dedupeKey: `CANCELLATION:${appointmentId}:doctor`,
        payload: {
          doctorName: appt.doctor.user.fullName,
          patientName: appt.patient.user.fullName,
          when,
          cancelledBy: actor,
          reason: reason ?? null,
        },
      },
    ]);

    return tx.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude });
  });

  await audit({
    ...ctx,
    action: 'appointment.cancelled',
    entityType: 'Appointment',
    entityId: appointmentId,
    metadata: { cancelledBy: actor, reason: reason ?? null },
  });

  return shapeAppointment(cancelled);
}

/**
 * Moves an appointment to a new slot.
 *
 * Implemented as cancel-old + create-new inside ONE transaction rather than an
 * UPDATE of slotStart. Two reasons: the reschedule chain stays auditable via
 * `rescheduledFromId`, and if the new slot is taken the constraint violation
 * rolls the whole thing back - leaving the original booking intact instead of
 * destroying it in a failed move.
 */
export async function rescheduleAppointment(appointmentId, user, { newSlotStart, reason }, ctx = {}) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { ...appointmentInclude, symptomReport: true },
  });
  if (!appt) throw new NotFoundError('Appointment');

  const actor = authorise(appt, user, 'reschedule');
  if (!['HELD', 'CONFIRMED'].includes(appt.status)) {
    throw new ConflictError(`Cannot reschedule an appointment in status ${appt.status}`);
  }
  if (newSlotStart.getTime() === appt.slotStart.getTime()) {
    throw new ValidationError('The new slot is the same as the current one');
  }

  const { slotEnd: newSlotEnd } = await assertSlotIsBookable(appt.doctorId, newSlotStart);
  await expireStaleHolds({ doctorId: appt.doctorId, slotStart: newSlotStart });

  const oldWhen = formatForHuman(appt.slotStart);
  const newWhen = formatForHuman(newSlotStart);
  const reminderAt = new Date(
    newSlotStart.getTime() - env.APPOINTMENT_REMINDER_LEAD_MINUTES * 60_000
  );

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const claimed = await tx.appointment.updateMany({
        where: { id: appointmentId, status: { in: ['HELD', 'CONFIRMED'] } },
        data: {
          status: 'CANCELLED',
          cancelledBy: actor,
          cancelledAt: new Date(),
          cancelReason: reason ?? 'Rescheduled',
          holdExpiresAt: null,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictError('This appointment was already changed by someone else');
      }

      const next = await tx.appointment.create({
        data: {
          doctorId: appt.doctorId,
          patientId: appt.patientId,
          slotStart: newSlotStart,
          slotEnd: newSlotEnd,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          reasonForVisit: appt.reasonForVisit,
          rescheduledFromId: appointmentId,
        },
      });

      // Carry the symptom report and its pending summary across.
      if (appt.symptomReport) {
        const { id, appointmentId: _drop, submittedAt, ...rest } = appt.symptomReport;
        await tx.symptomReport.create({ data: { ...rest, appointmentId: next.id } });
        await tx.preVisitSummary.create({ data: { appointmentId: next.id, status: 'PENDING' } });
      }

      await tx.notificationOutbox.updateMany({
        where: {
          appointmentId,
          status: { in: ['PENDING', 'FAILED'] },
          type: { in: ['APPOINTMENT_REMINDER', 'BOOKING_CONFIRMATION'] },
        },
        data: { status: 'CANCELLED' },
      });

      // Old appointment is CANCELLED so its events must go; the new one needs
      // its own pair.
      await tx.calendarEvent.updateMany({
        where: { appointmentId, status: { in: ['SYNCED', 'FAILED'] } },
        data: { status: 'PENDING', attempts: 0 },
      });
      await tx.calendarEvent.createMany({
        data: [
          { appointmentId: next.id, userId: appt.patient.user.id },
          { appointmentId: next.id, userId: appt.doctor.user.id },
        ],
        skipDuplicates: true,
      });

      await enqueueMany(tx, [
        {
          type: 'RESCHEDULE',
          recipientUserId: appt.patient.user.id,
          recipientEmail: appt.patient.user.email,
          recipientName: appt.patient.user.fullName,
          subject: `Appointment moved to ${newWhen}`,
          appointmentId: next.id,
          dedupeKey: `RESCHEDULE:${next.id}:patient`,
          payload: {
            patientName: appt.patient.user.fullName,
            doctorName: appt.doctor.user.fullName,
            oldWhen,
            when: newWhen,
            slotStart: newSlotStart.toISOString(),
          },
        },
        {
          type: 'RESCHEDULE',
          recipientUserId: appt.doctor.user.id,
          recipientEmail: appt.doctor.user.email,
          recipientName: appt.doctor.user.fullName,
          subject: `Appointment moved to ${newWhen}`,
          appointmentId: next.id,
          dedupeKey: `RESCHEDULE:${next.id}:doctor`,
          payload: {
            doctorName: appt.doctor.user.fullName,
            patientName: appt.patient.user.fullName,
            oldWhen,
            when: newWhen,
          },
        },
        {
          type: 'APPOINTMENT_REMINDER',
          recipientUserId: appt.patient.user.id,
          recipientEmail: appt.patient.user.email,
          recipientName: appt.patient.user.fullName,
          subject: `Reminder: appointment with ${appt.doctor.user.fullName}`,
          appointmentId: next.id,
          dedupeKey: `APPOINTMENT_REMINDER:${next.id}:patient`,
          notBefore: reminderAt > new Date() ? reminderAt : new Date(),
          payload: {
            patientName: appt.patient.user.fullName,
            doctorName: appt.doctor.user.fullName,
            when: newWhen,
          },
        },
      ]);

      return tx.appointment.findUnique({ where: { id: next.id }, include: appointmentInclude });
    });
  } catch (e) {
    // The original booking is untouched - the transaction rolled back.
    if (isSlotConflict(e)) throw new SlotUnavailableError();
    throw e;
  }

  await audit({
    ...ctx,
    action: 'appointment.rescheduled',
    entityType: 'Appointment',
    entityId: created.id,
    metadata: { from: appointmentId, oldSlot: appt.slotStart, newSlot: newSlotStart },
  });

  return shapeAppointment(created);
}

/**
 * Lists appointments scoped to the caller's role: patients see their own,
 * doctors see theirs, admins see everything. The scope is derived from the
 * token, never from a query parameter.
 */
export async function listAppointments(user, filters = {}) {
  const { status, from, to, page = 1, limit = 20, upcoming } = filters;

  const scope =
    user.role === 'ADMIN'
      ? {}
      : user.role === 'DOCTOR'
        ? { doctorId: user.doctorId }
        : { patientId: user.patientId };

  const where = {
    ...scope,
    ...(status ? { status: { in: Array.isArray(status) ? status : [status] } } : {}),
    ...(upcoming ? { slotStart: { gte: new Date() } } : {}),
    ...(from || to
      ? {
          slotStart: {
            ...(upcoming ? { gte: new Date() } : {}),
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include: appointmentInclude,
      orderBy: { slotStart: upcoming ? 'asc' : 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: rows.map(shapeAppointment),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Single appointment with the detail appropriate to the caller.
 *
 * The pre-visit summary is doctor/admin-only: it is clinical triage written for
 * the doctor, and showing a patient an "urgency: HIGH" label with no clinician
 * to interpret it would be actively harmful.
 */
export async function getAppointment(appointmentId, user) {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      ...appointmentInclude,
      symptomReport: true,
      preVisitSummary: true,
      postVisitSummary: true,
      visitNote: { include: { prescriptions: true } },
    },
  });
  if (!appt) throw new NotFoundError('Appointment');

  const viewer = authorise(appt, user, 'view');

  const base = {
    ...shapeAppointment(appt),
    symptomReport: appt.symptomReport ?? null,
    postVisitSummary:
      appt.postVisitSummary?.status === 'READY' || viewer !== 'PATIENT'
        ? (appt.postVisitSummary ?? null)
        : null,
  };

  if (viewer === 'PATIENT') return base;

  return {
    ...base,
    preVisitSummary: appt.preVisitSummary ?? null,
    visitNote: appt.visitNote ?? null,
  };
}
