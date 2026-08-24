/** Second half: visit notes, medication reminders, post-visit summary. */

export async function runPart2({ api, check, prisma, ctx, runSummaryPass }) {
  const { doctorToken, patientToken, apptId } = ctx;

  // --- visit notes ---------------------------------------------------------
  console.log('\nVisit notes + prescription');

  const notPatient = await api('POST', `/api/appointments/${apptId}/visit-note`, {
    token: patientToken,
    body: { clinicalNotes: 'Patient trying to write their own clinical notes.' },
  });
  check('patient cannot submit visit notes -> 403', notPatient.status === 403, `got ${notPatient.status}`);

  const note = await api('POST', `/api/appointments/${apptId}/visit-note`, {
    token: doctorToken,
    body: {
      clinicalNotes:
        'Pt c/o unilateral throbbing cephalalgia x4/7 with photophobia, nausea and one episode of emesis. ' +
        'No focal neurological deficit. No neck stiffness, afebrile. BP 124/78. ' +
        'Impression: migraine without aura. NSAID overuse likely contributing.',
      diagnosis: 'Migraine without aura',
      advice:
        'Stop routine ibuprofen use. Rest in a dark quiet room during attacks. ' +
        'Keep a headache diary. Return immediately if sudden severe headache, fever or neck stiffness.',
      followUpDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      prescriptions: [
        {
          medicationName: 'Sumatriptan',
          dosage: '50 mg',
          frequency: 'AS_NEEDED',
          durationDays: 30,
          instructions: 'at onset of headache, max 2 doses in 24 hours',
        },
        {
          medicationName: 'Propranolol',
          dosage: '40 mg',
          frequency: 'TWICE_DAILY',
          durationDays: 30,
          instructions: 'with food',
        },
      ],
    },
  });
  check('visit note submitted -> 201', note.status === 201, JSON.stringify(note.body).slice(0, 200));
  check('post-visit summary queued PENDING', note.body?.postVisitSummary?.status === 'PENDING');

  const appt = await prisma.appointment.findUnique({ where: { id: apptId } });
  check('appointment marked COMPLETED', appt.status === 'COMPLETED', appt.status);

  const duplicate = await api('POST', `/api/appointments/${apptId}/visit-note`, {
    token: doctorToken,
    body: { clinicalNotes: 'Attempting to submit a second set of notes.' },
  });
  check('duplicate visit note -> 409', duplicate.status === 409, `got ${duplicate.status}`);

  // --- medication reminders ------------------------------------------------
  console.log('\nMedication reminders');

  const reminders = await prisma.medicationReminder.findMany({
    where: { prescriptionItem: { visitNote: { appointmentId: apptId } } },
    include: { prescriptionItem: true },
    orderBy: { scheduledAt: 'asc' },
  });

  const propranolol = reminders.filter((r) => r.prescriptionItem.medicationName === 'Propranolol');
  const sumatriptan = reminders.filter((r) => r.prescriptionItem.medicationName === 'Sumatriptan');

  check(
    'TWICE_DAILY x 30 days => 60 reminders',
    propranolol.length === 60,
    `got ${propranolol.length}`
  );
  check(
    'AS_NEEDED generates no reminders',
    sumatriptan.length === 0,
    `got ${sumatriptan.length}`
  );
  check(
    'reminders are PENDING and in the future',
    propranolol.every((r) => r.status === 'PENDING' || r.scheduledAt < new Date()),
    'unexpected reminder status'
  );
  check(
    'timesPerDay derived from frequency',
    propranolol[0]?.prescriptionItem?.timesPerDay === 2,
    `got ${propranolol[0]?.prescriptionItem?.timesPerDay}`
  );

  const uniqueDays = new Set(
    propranolol.map((r) => r.scheduledAt.toISOString().slice(0, 10))
  );
  check('spread across ~30 distinct days', uniqueDays.size >= 29, `got ${uniqueDays.size}`);

  // --- post-visit summary --------------------------------------------------
  console.log('\nPost-visit summary generation');

  // Same reasoning as the pre-visit case: target this appointment directly so
  // the assertion does not depend on global queue depth.
  const { generatePostVisitSummary } = await import('../src/modules/summaries/summaries.service.js');
  const t0 = Date.now();
  const genResult = await generatePostVisitSummary(apptId);
  console.log(`  (generation took ${Date.now() - t0}ms -> ${genResult.status})`);

  const post = await api('GET', `/api/appointments/${apptId}/post-visit-summary`, {
    token: patientToken,
  });
  check('patient can read the post-visit summary', post.status === 200, `got ${post.status}`);
  check('status READY', post.body?.status === 'READY', post.body?.status);
  check('plain-language text present', String(post.body?.patientFriendlyText ?? '').length > 40);
  check(
    'medication schedule derived from the prescription',
    Array.isArray(post.body?.medicationSchedule) && post.body.medicationSchedule.length >= 1,
    `got ${post.body?.medicationSchedule?.length}`
  );
  check(
    'follow-up steps present',
    Array.isArray(post.body?.followUpSteps) && post.body.followUpSteps.length >= 1
  );

  const text = String(post.body?.patientFriendlyText ?? '').toLowerCase();
  check(
    'clinical jargon translated (no "cephalalgia"/"emesis")',
    !text.includes('cephalalgia') && !text.includes('emesis'),
    'jargon leaked into the patient summary'
  );

  const meds = (post.body?.medicationSchedule ?? []).map((m) => m.medication.toLowerCase());
  check(
    'no medication invented beyond the prescription',
    meds.every((m) => m.includes('sumatriptan') || m.includes('propranolol')),
    meds.join(', ')
  );

  console.log(`\n  summary: ${String(post.body?.patientFriendlyText).slice(0, 160)}...`);
  console.log(`  meds   : ${(post.body?.medicationSchedule ?? []).map((m) => `${m.medication} (${(m.whenToTake || []).join('/')})`).join('; ')}`);
  if (post.body?.warningSigns?.length) {
    console.log(`  warning: ${post.body.warningSigns.join('; ')}`);
  }
}
