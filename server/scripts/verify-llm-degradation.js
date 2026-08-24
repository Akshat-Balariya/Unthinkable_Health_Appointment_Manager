/**
 * Proves the system degrades rather than breaks when the LLM provider fails.
 *
 * Run with a deliberately invalid key:
 *   GEMINI_API_KEY=broken-key node scripts/verify-llm-degradation.js
 *
 * The npm script `verify:degradation` does this for you.
 *
 * Everything here goes through the service layer, so no server is needed.
 */
import { PrismaClient } from '@prisma/client';
import { holdSlot, confirmBooking } from '../src/modules/appointments/booking.service.js';
import { createDoctor } from '../src/modules/admin/doctors.service.js';
import { registerPatient } from '../src/modules/auth/auth.service.js';
import { submitVisitNote } from '../src/modules/summaries/visitNotes.service.js';
import {
  generatePreVisitSummary,
  generatePostVisitSummary,
} from '../src/modules/summaries/summaries.service.js';
import { utcFromLocal, addDaysToKey, dateKey } from '../src/lib/time.js';
import { activeLlmProvider } from '../src/config/env.js';

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
  console.log(`\nLLM degradation test (provider: ${activeLlmProvider()}, key deliberately invalid)\n`);

  const doctor = await createDoctor({
    email: `dr.degrade.${stamp}@clinic.test`,
    password: 'Passw0rdTest',
    fullName: 'Dr Degrade',
    specialisation: 'Degradation Testing',
    slotDurationMin: 30,
    workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      startTime: '09:00',
      endTime: '17:00',
    })),
  });

  const { user: patientUser } = await registerPatient({
    email: `degrade.patient.${stamp}@example.test`,
    password: 'Passw0rdTest',
    fullName: 'Degrade Patient',
  });
  const patientProfile = await prisma.patientProfile.findUnique({
    where: { userId: patientUser.id },
  });

  const day = addDaysToKey(dateKey(new Date()), 13);

  // --- booking must be unaffected -----------------------------------------
  console.log('Booking with the provider down');

  const held = await holdSlot({
    patientId: patientProfile.id,
    doctorId: doctor.id,
    slotStart: utcFromLocal(day, '10:00'),
  });
  check('slot hold succeeds', held.status === 'HELD');

  const confirmed = await confirmBooking(
    held.id,
    { patientId: patientProfile.id, role: 'PATIENT' },
    {
      symptomsText: 'Sore throat and mild fever for two days, difficulty swallowing solid food.',
      durationDays: 2,
      severity: 5,
    }
  );
  check('booking confirms despite the provider being down', confirmed.status === 'CONFIRMED');

  const symptomRow = await prisma.symptomReport.findUnique({ where: { appointmentId: held.id } });
  check('symptom report persisted', Boolean(symptomRow?.symptomsText));

  // --- generation fails without throwing -----------------------------------
  console.log('\nSummary generation under failure');

  let threw = false;
  let result;
  try {
    result = await generatePreVisitSummary(held.id);
  } catch (e) {
    threw = true;
  }
  check('generatePreVisitSummary does not throw', !threw);
  check(
    'returns a non-READY status',
    result && result.status !== 'READY',
    `got ${result?.status}`
  );

  const summary = await prisma.preVisitSummary.findUnique({ where: { appointmentId: held.id } });
  check('failure recorded on the row', Boolean(summary?.lastError), 'lastError empty');
  check('attempt counter incremented', summary?.attempts >= 1, `attempts=${summary?.attempts}`);
  check(
    'row stays PENDING while retries remain',
    summary?.status === 'PENDING',
    `status=${summary?.status}`
  );
  console.log(`    recorded error: ${String(summary?.lastError).slice(0, 110)}...`);

  const apptAfter = await prisma.appointment.findUnique({ where: { id: held.id } });
  check(
    'appointment untouched by the failure',
    apptAfter.status === 'CONFIRMED',
    `status=${apptAfter.status}`
  );

  // --- retries eventually park the row as FAILED ---------------------------
  console.log('\nRetry exhaustion');

  for (let i = 0; i < 4; i += 1) {
    await generatePreVisitSummary(held.id);
  }
  const exhausted = await prisma.preVisitSummary.findUnique({
    where: { appointmentId: held.id },
  });
  check(
    'parked as FAILED after 5 attempts',
    exhausted?.status === 'FAILED',
    `status=${exhausted?.status} attempts=${exhausted?.attempts}`
  );
  check('FAILED row still carries the reason', Boolean(exhausted?.lastError));

  // --- the doctor is not left with nothing ---------------------------------
  const stillReadable = await prisma.appointment.findUnique({
    where: { id: held.id },
    include: { symptomReport: true, preVisitSummary: true },
  });
  check(
    'raw symptom text remains available to the doctor',
    Boolean(stillReadable.symptomReport?.symptomsText),
    'symptom text lost'
  );

  // --- post-visit path degrades the same way -------------------------------
  console.log('\nPost-visit path');

  const note = await submitVisitNote(
    held.id,
    { doctorId: doctor.id, role: 'DOCTOR' },
    {
      clinicalNotes: 'Pharyngitis, likely viral. Symptomatic management advised.',
      diagnosis: 'Acute viral pharyngitis',
      prescriptions: [
        {
          medicationName: 'Paracetamol',
          dosage: '500 mg',
          frequency: 'THRICE_DAILY',
          durationDays: 5,
        },
      ],
    }
  );
  check('visit note submits with the provider down', Boolean(note.visitNote?.id));
  // THRICE_DAILY x 5 days = 15 doses. Doses whose wall-clock time has already
  // passed today are materialised as CANCELLED rather than dropped, so the
  // schedule stays a complete record - hence PENDING is 15 minus however many
  // of today's dose times are already behind us.
  const doses = await prisma.medicationReminder.findMany({
    where: { prescriptionItem: { visitNoteId: note.visitNote.id } },
  });
  const pending = doses.filter((d) => d.status === 'PENDING');
  const cancelled = doses.filter((d) => d.status === 'CANCELLED');
  check('all 15 doses materialised', doses.length === 15, `got ${doses.length}`);
  check(
    'pending + already-past accounts for every dose',
    pending.length + cancelled.length === 15,
    `${pending.length} pending + ${cancelled.length} past`
  );
  check(
    'only past doses were cancelled',
    cancelled.every((d) => d.scheduledAt < new Date()),
    'a future dose was cancelled'
  );
  check(
    'reminder count returned matches PENDING rows',
    note.remindersScheduled === pending.length,
    `returned ${note.remindersScheduled}, found ${pending.length}`
  );

  const postResult = await generatePostVisitSummary(held.id);
  check('post-visit generation does not throw', postResult.status !== 'READY');

  const apptFinal = await prisma.appointment.findUnique({ where: { id: held.id } });
  check('appointment reached COMPLETED regardless', apptFinal.status === 'COMPLETED');

  // --- cleanup -------------------------------------------------------------
  const docProfile = await prisma.doctorProfile.findUnique({ where: { id: doctor.id } });
  await prisma.appointment.deleteMany({ where: { doctorId: doctor.id } });
  await prisma.user.delete({ where: { id: docProfile.userId } });
  await prisma.user.delete({ where: { id: patientUser.id } });
  console.log('\n  cleaned up');
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\ndegradation test crashed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
