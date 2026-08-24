import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';
import { audit } from '../../lib/audit.js';
import { enqueueMany } from '../../lib/outbox.js';
import { leaveRangeUtc, formatForHuman } from '../../lib/time.js';
import { logger } from '../../lib/logger.js';

const log = logger.child('admin.doctors');

/**
 * Tenancy guard.
 *
 * `ctx.clinicId` is set for CLINIC_ADMIN callers and null for platform ADMINs.
 * A doctor outside the caller's clinic raises NotFoundError rather than
 * ForbiddenError deliberately: a 403 would confirm the id exists, letting one
 * clinic enumerate another's staff.
 */
function assertScope(doctor, ctx) {
  if (ctx?.clinicId && doctor.clinicId !== ctx.clinicId) throw new NotFoundError('Doctor');
  return doctor;
}

const doctorInclude = {
  user: {
    select: { id: true, email: true, fullName: true, phone: true, isActive: true, timezone: true },
  },
  workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
};

function shapeDoctor(d) {
  if (!d) return null;
  return {
    id: d.id,
    userId: d.userId,
    clinicId: d.clinicId,
    email: d.user.email,
    fullName: d.user.fullName,
    phone: d.user.phone,
    timezone: d.user.timezone,
    specialisation: d.specialisation,
    qualifications: d.qualifications,
    bio: d.bio,
    licenseNumber: d.licenseNumber,
    consultationFee: Number(d.consultationFee),
    slotDurationMin: d.slotDurationMin,
    bufferMin: d.bufferMin,
    maxAdvanceDays: d.maxAdvanceDays,
    minNoticeMin: d.minNoticeMin,
    isActive: d.isActive && d.user.isActive,
    workingHours: (d.workingHours ?? []).map((w) => ({
      id: w.id,
      dayOfWeek: w.dayOfWeek,
      startTime: w.startTime,
      endTime: w.endTime,
      isActive: w.isActive,
    })),
    createdAt: d.createdAt,
  };
}

export { shapeDoctor };

/** Creates the User and DoctorProfile together; neither may exist alone. */
export async function createDoctor(input, ctx = {}) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new ConflictError('An account with that email already exists');

  const passwordHash = await hashPassword(input.password);

  const doctor = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        role: 'DOCTOR',
        fullName: input.fullName,
        phone: input.phone,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });

    return tx.doctorProfile.create({
      data: {
        userId: user.id,
        // Scoped callers may only create within their own clinic; a platform
        // admin may target one explicitly.
        clinicId: ctx.clinicId ?? input.clinicId ?? null,
        specialisation: input.specialisation,
        qualifications: input.qualifications,
        bio: input.bio,
        licenseNumber: input.licenseNumber,
        ...(input.consultationFee !== undefined ? { consultationFee: input.consultationFee } : {}),
        ...(input.slotDurationMin !== undefined ? { slotDurationMin: input.slotDurationMin } : {}),
        ...(input.bufferMin !== undefined ? { bufferMin: input.bufferMin } : {}),
        ...(input.maxAdvanceDays !== undefined ? { maxAdvanceDays: input.maxAdvanceDays } : {}),
        ...(input.minNoticeMin !== undefined ? { minNoticeMin: input.minNoticeMin } : {}),
        workingHours: {
          createMany: {
            data: (input.workingHours ?? []).map((w) => ({
              dayOfWeek: w.dayOfWeek,
              startTime: w.startTime,
              endTime: w.endTime,
              isActive: w.isActive ?? true,
            })),
          },
        },
      },
      include: doctorInclude,
    });
  });

  await audit({
    ...ctx,
    action: 'doctor.created',
    entityType: 'DoctorProfile',
    entityId: doctor.id,
    metadata: { email: input.email, specialisation: input.specialisation },
  });

  return shapeDoctor(doctor);
}

export async function listDoctors({ specialisation, q, isActive, page, limit, clinicId }) {
  const where = {
    ...(clinicId ? { clinicId } : {}),
    ...(specialisation ? { specialisation: { equals: specialisation, mode: 'insensitive' } } : {}),
    ...(isActive !== undefined ? { isActive } : {}),
    ...(q
      ? {
          OR: [
            { user: { fullName: { contains: q, mode: 'insensitive' } } },
            { user: { email: { contains: q, mode: 'insensitive' } } },
            { specialisation: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.doctorProfile.count({ where }),
    prisma.doctorProfile.findMany({
      where,
      include: doctorInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: rows.map(shapeDoctor),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getDoctor(id, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id }, include: doctorInclude });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);
  return shapeDoctor(doctor);
}

/** Splits an update across the User and DoctorProfile tables. */
export async function updateDoctor(id, patch, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id } });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  const userFields = {};
  if (patch.fullName !== undefined) userFields.fullName = patch.fullName;
  if (patch.phone !== undefined) userFields.phone = patch.phone;

  const profileFields = {};
  for (const k of [
    'specialisation',
    'qualifications',
    'bio',
    'licenseNumber',
    'consultationFee',
    'slotDurationMin',
    'bufferMin',
    'maxAdvanceDays',
    'minNoticeMin',
    'isActive',
  ]) {
    if (patch[k] !== undefined) profileFields[k] = patch[k];
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (Object.keys(userFields).length) {
      await tx.user.update({ where: { id: doctor.userId }, data: userFields });
    }
    return tx.doctorProfile.update({
      where: { id },
      data: profileFields,
      include: doctorInclude,
    });
  });

  await audit({
    ...ctx,
    action: 'doctor.updated',
    entityType: 'DoctorProfile',
    entityId: id,
    metadata: { fields: Object.keys({ ...userFields, ...profileFields }) },
  });

  // Changing slot geometry reshapes future availability. Existing bookings stay
  // valid: the EXCLUDE constraint stops a regenerated grid from overlapping them.
  if (profileFields.slotDurationMin !== undefined || profileFields.bufferMin !== undefined) {
    log.info('slot geometry changed; future availability reshaped', { doctorId: id });
  }

  return shapeDoctor(updated);
}

/** Soft delete - appointments reference this row, so it is never dropped. */
export async function deactivateDoctor(id, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id } });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  const upcoming = await prisma.appointment.count({
    where: { doctorId: id, status: { in: ['HELD', 'CONFIRMED'] }, slotStart: { gte: new Date() } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.doctorProfile.update({ where: { id }, data: { isActive: false } });
    await tx.user.update({ where: { id: doctor.userId }, data: { isActive: false } });
  });

  await audit({
    ...ctx,
    action: 'doctor.deactivated',
    entityType: 'DoctorProfile',
    entityId: id,
    metadata: { upcomingAppointments: upcoming },
  });

  return { id, isActive: false, upcomingAppointments: upcoming };
}

/** Replaces the whole weekly schedule - simpler and safer than per-row diffing. */
export async function replaceWorkingHours(id, workingHours, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id } });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.doctorWorkingHour.deleteMany({ where: { doctorId: id } });
    await tx.doctorWorkingHour.createMany({
      data: workingHours.map((w) => ({
        doctorId: id,
        dayOfWeek: w.dayOfWeek,
        startTime: w.startTime,
        endTime: w.endTime,
        isActive: w.isActive ?? true,
      })),
    });
    return tx.doctorProfile.findUnique({ where: { id }, include: doctorInclude });
  });

  await audit({
    ...ctx,
    action: 'doctor.working_hours_replaced',
    entityType: 'DoctorProfile',
    entityId: id,
    metadata: { blocks: workingHours.length },
  });

  return shapeDoctor(updated);
}

// ---------------------------------------------------------------------------
// Leave management
// ---------------------------------------------------------------------------

/**
 * Appointments that collide with a leave window.
 *
 * Overlap test is `slotStart < rangeEnd AND slotEnd > rangeStart` - the correct
 * half-open comparison. An appointment ending exactly when the leave begins does
 * NOT conflict.
 */
export async function findConflictingAppointments(doctorId, range, client = prisma) {
  return client.appointment.findMany({
    where: {
      doctorId,
      status: { in: ['HELD', 'CONFIRMED'] },
      slotStart: { lt: range.end },
      slotEnd: { gt: range.start },
    },
    include: {
      patient: { include: { user: { select: { id: true, email: true, fullName: true } } } },
    },
    orderBy: { slotStart: 'asc' },
  });
}

/**
 * Previews what marking this leave would cancel, without writing anything.
 * The admin UI calls this first, so leave is never a surprise bulk cancellation.
 */
export async function previewLeaveConflicts(doctorId, leaveInput, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  const range = leaveRangeUtc(leaveInput);
  const conflicts = await findConflictingAppointments(doctorId, range);

  return {
    range: { start: range.start, end: range.end },
    affectedCount: conflicts.length,
    affected: conflicts.map((a) => ({
      appointmentId: a.id,
      slotStart: a.slotStart,
      slotEnd: a.slotEnd,
      status: a.status,
      patientName: a.patient.user.fullName,
      patientEmail: a.patient.user.email,
    })),
  };
}

export async function listLeaves(doctorId, { from, to } = {}, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  return prisma.doctorLeave.findMany({
    where: {
      doctorId,
      ...(from || to
        ? { leaveDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    orderBy: { leaveDate: 'asc' },
  });
}

/**
 * Removes a leave. Appointments it cancelled are NOT resurrected - patients were
 * already told, and those slots may since have been taken by someone else.
 */
export async function deleteLeave(doctorId, leaveId, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  const leave = await prisma.doctorLeave.findFirst({ where: { id: leaveId, doctorId } });
  if (!leave) throw new NotFoundError('Leave');

  await prisma.doctorLeave.delete({ where: { id: leaveId } });

  await audit({
    ...ctx,
    action: 'leave.deleted',
    entityType: 'DoctorLeave',
    entityId: leaveId,
    metadata: { doctorId, leaveDate: leave.leaveDate },
  });

  return { id: leaveId, deleted: true };
}

/**
 * Marks a doctor on leave and cascades the consequences atomically:
 *
 *   1. the leave row is created
 *   2. every overlapping HELD/CONFIRMED appointment is cancelled
 *   3. a notification is queued for each affected patient, plus one digest to
 *      the doctor
 *   4. reminders already queued for those appointments are superseded, so no
 *      patient receives "your appointment is tomorrow" after it was called off
 *
 * All four happen in ONE transaction. There is no window in which appointments
 * are cancelled but nobody was told, nor one in which the leave exists but the
 * appointments still stand.
 */
export async function createLeave(doctorId, input, ctx = {}) {
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    include: { user: { select: { id: true, email: true, fullName: true } } },
  });
  if (!doctor) throw new NotFoundError('Doctor');
  assertScope(doctor, ctx);

  const range = leaveRangeUtc(input);

  // Postgres treats NULLs as distinct in unique indexes, so the schema-level
  // @@unique cannot stop two identical whole-day leaves. Check explicitly.
  const duplicate = await prisma.doctorLeave.findFirst({
    where: { doctorId, leaveDate: input.leaveDate, startTime: input.startTime ?? null },
  });
  if (duplicate) throw new ConflictError('That leave has already been recorded');

  const result = await prisma.$transaction(async (tx) => {
    const leave = await tx.doctorLeave.create({
      data: {
        doctorId,
        leaveDate: input.leaveDate,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        reason: input.reason ?? null,
        createdBy: ctx.actorUserId ?? null,
      },
    });

    const conflicts = await findConflictingAppointments(doctorId, range, tx);
    if (conflicts.length === 0) return { leave, affected: [], notificationsQueued: 0 };

    const ids = conflicts.map((a) => a.id);

    await tx.appointment.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'CANCELLED',
        cancelledBy: 'ADMIN',
        cancelledAt: new Date(),
        cancelReason: input.reason
          ? `Doctor unavailable: ${input.reason}`
          : 'Doctor unavailable on this date',
      },
    });

    await tx.notificationOutbox.updateMany({
      where: {
        appointmentId: { in: ids },
        status: { in: ['PENDING', 'FAILED'] },
        type: { in: ['APPOINTMENT_REMINDER', 'BOOKING_CONFIRMATION'] },
      },
      data: { status: 'CANCELLED' },
    });

    const messages = conflicts.map((appt) => {
      const when = formatForHuman(appt.slotStart);
      return {
        type: 'LEAVE_CANCELLATION',
        recipientUserId: appt.patient.user.id,
        recipientEmail: appt.patient.user.email,
        recipientName: appt.patient.user.fullName,
        subject: `Your appointment on ${when} has been cancelled`,
        appointmentId: appt.id,
        dedupeKey: `LEAVE_CANCELLATION:${appt.id}:${appt.patient.user.id}`,
        payload: {
          patientName: appt.patient.user.fullName,
          doctorName: doctor.user.fullName,
          specialisation: doctor.specialisation,
          slotStart: appt.slotStart.toISOString(),
          when,
          reason: input.reason ?? 'The doctor is unavailable on this date',
        },
      };
    });

    // One digest to the doctor rather than one email per cancelled slot.
    messages.push({
      type: 'LEAVE_CANCELLATION',
      recipientUserId: doctor.user.id,
      recipientEmail: doctor.user.email,
      recipientName: doctor.user.fullName,
      subject: `${conflicts.length} appointment(s) cancelled for your leave`,
      dedupeKey: `LEAVE_DIGEST:${leave.id}`,
      payload: {
        doctorName: doctor.user.fullName,
        leaveDate: leave.leaveDate.toISOString(),
        cancelledCount: conflicts.length,
        appointments: conflicts.map((a) => ({
          when: formatForHuman(a.slotStart),
          patientName: a.patient.user.fullName,
        })),
      },
    });

    const queued = await enqueueMany(tx, messages);

    return {
      leave,
      affected: conflicts.map((a) => ({
        appointmentId: a.id,
        slotStart: a.slotStart,
        patientName: a.patient.user.fullName,
        patientEmail: a.patient.user.email,
      })),
      notificationsQueued: queued,
    };
  });

  await audit({
    ...ctx,
    action: 'leave.created',
    entityType: 'DoctorLeave',
    entityId: result.leave.id,
    metadata: {
      doctorId,
      cancelledAppointments: result.affected.length,
      notificationsQueued: result.notificationsQueued,
    },
  });

  if (result.affected.length) {
    log.warn('leave cancelled existing appointments', {
      doctorId,
      count: result.affected.length,
      queued: result.notificationsQueued,
    });
  }

  return result;
}
