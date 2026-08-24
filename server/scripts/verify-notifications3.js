/** Third part: medication reminder dispatch. */

export async function runPart3({ check, prisma, runOutboxPass, runReminderPass }) {
  console.log('\nMedication reminders');

  const visitNote = await prisma.visitNote.findFirst({
    include: { prescriptions: true, appointment: true },
  });
  if (!visitNote?.prescriptions?.length) {
    check('a prescription exists to test against', false, 'run verify:summaries first');
    return;
  }

  const item = visitNote.prescriptions[0];
  const patientId = visitNote.appointment.patientId;

  // One dose due now, one so old it is past the grace window.
  const dueNow = await prisma.medicationReminder.create({
    data: {
      prescriptionItemId: item.id,
      patientId,
      scheduledAt: new Date(Date.now() - 60_000),
      status: 'PENDING',
    },
  });
  const tooOld = await prisma.medicationReminder.create({
    data: {
      prescriptionItemId: item.id,
      patientId,
      scheduledAt: new Date(Date.now() - 48 * 3_600_000),
      status: 'PENDING',
    },
  });

  const result = await runReminderPass({ batchSize: 200 });
  check('due reminder picked up', result.queued >= 1, JSON.stringify(result));

  const dueAfter = await prisma.medicationReminder.findUnique({ where: { id: dueNow.id } });
  check('due reminder marked SENT', dueAfter.status === 'SENT', dueAfter.status);

  const oldAfter = await prisma.medicationReminder.findUnique({ where: { id: tooOld.id } });
  check(
    'dose missed beyond the grace window is abandoned, not sent late',
    oldAfter.status === 'CANCELLED',
    oldAfter.status
  );

  const email = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `MEDICATION_REMINDER:${dueNow.id}` },
  });
  check('an outbox row was created for the dose', Boolean(email));
  check(
    'payload carries the medication name',
    email?.payload?.medicationName === item.medicationName,
    JSON.stringify(email?.payload)
  );

  // Re-running must not double-send.
  await runReminderPass({ batchSize: 200 });
  const dupes = await prisma.notificationOutbox.count({
    where: { dedupeKey: `MEDICATION_REMINDER:${dueNow.id}` },
  });
  check('re-running the pass does not duplicate the dose email', dupes === 1, `found ${dupes}`);

  await runOutboxPass({ batchSize: 50 });
  const delivered = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `MEDICATION_REMINDER:${dueNow.id}` },
  });
  check('reminder email delivered', delivered.status === 'SENT', delivered.status);

  await prisma.notificationOutbox.deleteMany({
    where: { dedupeKey: { startsWith: 'MEDICATION_REMINDER:' } },
  });
  await prisma.medicationReminder.deleteMany({
    where: { id: { in: [dueNow.id, tooOld.id] } },
  });
  console.log('\n  cleaned up test rows');
}
