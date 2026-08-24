/**
 * Proves the doctor-leave conflict cascade.
 *
 * Appointments are inserted directly here because the booking API arrives in
 * Part 3. Asserts that marking leave (a) cancels every overlapping appointment,
 * (b) queues one notification per affected patient plus a doctor digest, and
 * (c) supersedes reminders that were already queued.
 *
 * Run:  node scripts/verify-leave-cascade.js
 */
import { PrismaClient } from '@prisma/client';
import * as doctors from '../src/modules/admin/doctors.service.js';
import { utcFromLocal, addDaysToKey, dateKey } from '../src/lib/time.js';

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
};

async function main() {
  const stamp = Date.now();
  const email = `dr.cascade.${stamp}@clinic.test`;

  const doctor = await doctors.createDoctor({
    email,
    password: 'Passw0rdTest',
    fullName: 'Dr Cascade',
    specialisation: 'Cascade Testing',
    slotDurationMin: 30,
    workingHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  });

  const patients = await prisma.patientProfile.findMany({
    take: 3,
    include: { user: true },
  });

  // A day far enough out that nothing else touches it.
  const day = addDaysToKey(dateKey(new Date()), 60);

  // Three appointments on the leave day, one the day before as a control.
  const onDay = ['09:00', '10:00', '11:00'];
  const created = [];
  for (let i = 0; i < onDay.length; i += 1) {
    const start = utcFromLocal(day, onDay[i]);
    created.push(
      await prisma.appointment.create({
        data: {
          doctorId: doctor.id,
          patientId: patients[i % patients.length].id,
          slotStart: start,
          slotEnd: new Date(start.getTime() + 30 * 60_000),
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      })
    );
  }

  const controlDay = addDaysToKey(day, -1);
  const controlStart = utcFromLocal(controlDay, '10:00');
  const control = await prisma.appointment.create({
    data: {
      doctorId: doctor.id,
      patientId: patients[0].id,
      slotStart: controlStart,
      slotEnd: new Date(controlStart.getTime() + 30 * 60_000),
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    },
  });

  // A reminder already queued for one of the doomed appointments.
  await prisma.notificationOutbox.create({
    data: {
      type: 'APPOINTMENT_REMINDER',
      recipientEmail: patients[0].user.email,
      subject: 'Reminder: your appointment is tomorrow',
      payload: {},
      dedupeKey: `APPOINTMENT_REMINDER:${created[0].id}`,
      appointmentId: created[0].id,
      status: 'PENDING',
    },
  });

  console.log(`\nDoctor ${doctor.fullName}, leave day ${day}`);
  console.log(`  ${created.length} appointments on that day, 1 control on ${controlDay}\n`);

  // --- preview must not mutate --------------------------------------------
  const preview = await doctors.previewLeaveConflicts(doctor.id, {
    leaveDate: new Date(`${day}T00:00:00Z`),
  });
  check('preview finds all 3 conflicts', preview.affectedCount === 3, `got ${preview.affectedCount}`);

  const stillConfirmed = await prisma.appointment.count({
    where: { doctorId: doctor.id, status: 'CONFIRMED' },
  });
  check('preview mutated nothing', stillConfirmed === 4, `${stillConfirmed} still CONFIRMED`);

  // --- the cascade ---------------------------------------------------------
  const result = await doctors.createLeave(
    doctor.id,
    { leaveDate: new Date(`${day}T00:00:00Z`), reason: 'Medical conference' },
    { actorUserId: null }
  );

  check('cascade reports 3 affected', result.affected.length === 3, `got ${result.affected.length}`);

  const cancelled = await prisma.appointment.findMany({
    where: { id: { in: created.map((a) => a.id) } },
  });
  check(
    'all 3 appointments CANCELLED',
    cancelled.every((a) => a.status === 'CANCELLED'),
    cancelled.map((a) => a.status).join(',')
  );
  check(
    'cancelledBy recorded as ADMIN',
    cancelled.every((a) => a.cancelledBy === 'ADMIN')
  );
  check(
    'cancel reason carries the leave reason',
    cancelled.every((a) => a.cancelReason?.includes('Medical conference'))
  );

  const controlAfter = await prisma.appointment.findUnique({ where: { id: control.id } });
  check('control appointment untouched', controlAfter.status === 'CONFIRMED', controlAfter.status);

  // --- notifications -------------------------------------------------------
  const queued = await prisma.notificationOutbox.findMany({
    where: { type: 'LEAVE_CANCELLATION', appointmentId: { in: created.map((a) => a.id) } },
  });
  check('one notification per affected patient', queued.length === 3, `got ${queued.length}`);
  check('all queued PENDING', queued.every((n) => n.status === 'PENDING'));
  check(
    'payload carries doctor + time',
    queued.every((n) => n.payload?.doctorName && n.payload?.when)
  );

  const digest = await prisma.notificationOutbox.findFirst({
    where: { dedupeKey: `LEAVE_DIGEST:${result.leave.id}` },
  });
  check('doctor digest queued', Boolean(digest));
  check('digest counts 3 cancellations', digest?.payload?.cancelledCount === 3);

  const supersededReminder = await prisma.notificationOutbox.findFirst({
    where: { dedupeKey: `APPOINTMENT_REMINDER:${created[0].id}` },
  });
  check(
    'pre-existing reminder superseded',
    supersededReminder?.status === 'CANCELLED',
    `status ${supersededReminder?.status}`
  );

  // --- idempotency ---------------------------------------------------------
  let duplicateRejected = false;
  try {
    await doctors.createLeave(doctor.id, { leaveDate: new Date(`${day}T00:00:00Z`) }, {});
  } catch (e) {
    duplicateRejected = e.code === 'CONFLICT';
  }
  check('duplicate leave rejected', duplicateRejected);

  // --- cleanup -------------------------------------------------------------
  const user = await prisma.user.findUnique({ where: { email } });
  await prisma.appointment.deleteMany({ where: { doctorId: doctor.id } });
  await prisma.doctorLeave.deleteMany({ where: { doctorId: doctor.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('\n  cleaned up test doctor and appointments');
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\ncascade verification crashed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
