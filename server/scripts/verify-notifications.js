/**
 * Verification for Part 5: outbox delivery, retry, dead-lettering, idempotency,
 * concurrent-worker safety, and medication reminders.
 *
 * No server needed - drives the jobs directly.
 *   node scripts/verify-notifications.js
 */
import { PrismaClient } from '@prisma/client';
import { runOutboxPass, retryDeadLetters } from '../src/jobs/outboxWorker.js';
import { runReminderPass } from '../src/jobs/reminderJob.js';
import { enqueueMany, enqueueNotification } from '../src/lib/outbox.js';
import { renderNotification, knownTemplates } from '../src/lib/mail/templates.js';

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

const TAG = `verify-${Date.now()}`;

async function main() {
  console.log(`\nNotification worker verification\n`);

  // Clear anything other suites left queued BEFORE the first assertion.
  // The claim order is `nextAttemptAt ASC`, so pre-existing rows are always
  // older and would be claimed ahead of this test's rows, starving them out of
  // every batch and making the counts below meaningless.
  let drainGuard = 0;
  let drainedTotal = 0;
  while (drainGuard < 40) {
    const drained = await runOutboxPass({ batchSize: 50 });
    if (drained.claimed === 0) break;
    drainedTotal += drained.claimed;
    drainGuard += 1;
  }
  if (drainedTotal > 0) console.log(`  (drained ${drainedTotal} pre-existing rows first)`);

  // --- templates -----------------------------------------------------------
  console.log('Templates');

  for (const type of knownTemplates()) {
    const r = renderNotification(type, {
      when: 'Mon 1 Jan 2027 at 9:00 AM',
      doctorName: 'Dr Test',
      patientName: 'Test Patient',
      medicationName: 'Amoxicillin',
      dosage: '500 mg',
      cancelledCount: 2,
      appointments: [{ when: 'x', patientName: 'y' }],
      fullName: 'Test Patient',
    });
    if (!r.html || !r.text) {
      check(`${type} renders both html and text`, false);
    }
  }
  check('every template renders html + text', true);

  const unknown = renderNotification('NOT_A_REAL_TYPE', {});
  check('unknown type falls back rather than throwing', Boolean(unknown.html && unknown.text));

  const escaped = renderNotification('CANCELLATION', {
    when: 'today',
    reason: '<script>alert(1)</script>',
  });
  check(
    'payload is HTML-escaped',
    !escaped.html.includes('<script>'),
    'unescaped payload reached the template'
  );

  // --- happy path ----------------------------------------------------------
  console.log('\nDelivery');

  const rows = Array.from({ length: 6 }, (_, i) => ({
    type: 'BOOKING_CONFIRMATION',
    recipientEmail: `${TAG}.happy${i}@example.test`,
    recipientName: `Happy ${i}`,
    subject: `Test message ${i}`,
    dedupeKey: `${TAG}:happy:${i}`,
    payload: { when: 'Mon 1 Jan 2027 at 9:00 AM', doctorName: 'Dr Test' },
  }));
  const queued = await enqueueMany(null, rows);
  check('6 notifications queued', queued === 6, `queued ${queued}`);

  const dbg = await prisma.notificationOutbox.findMany({
    where: { dedupeKey: { startsWith: `${TAG}:happy:` } },
    select: { status: true, nextAttemptAt: true },
  });
  console.log('    DEBUG rows=%d status=%s nextAttemptAt=%s jsNow=%s',
    dbg.length,
    [...new Set(dbg.map((r) => r.status))].join(','),
    dbg[0]?.nextAttemptAt?.toISOString(),
    new Date().toISOString());

  const result = await runOutboxPass({ batchSize: 10 });
  check('pass claims and sends them', result.sent >= 6, JSON.stringify(result));

  const sent = await prisma.notificationOutbox.findMany({
    where: { dedupeKey: { startsWith: `${TAG}:happy:` } },
  });
  check('all marked SENT', sent.every((r) => r.status === 'SENT'));
  check('sentAt recorded', sent.every((r) => r.sentAt !== null));
  check('provider message id stored', sent.every((r) => r.providerMessageId));
  check('each attempted exactly once', sent.every((r) => r.attempts === 1),
    sent.map((r) => r.attempts).join(','));

  // --- idempotency ---------------------------------------------------------
  console.log('\nIdempotency');

  const again = await enqueueNotification(null, {
    type: 'BOOKING_CONFIRMATION',
    recipientEmail: `${TAG}.happy0@example.test`,
    subject: 'Duplicate attempt',
    dedupeKey: `${TAG}:happy:0`,
    payload: {},
  });
  check('re-enqueueing the same dedupeKey is a no-op', again === false);

  const dupCount = await prisma.notificationOutbox.count({
    where: { dedupeKey: `${TAG}:happy:0` },
  });
  check('still exactly one row for that key', dupCount === 1, `found ${dupCount}`);

  // --- cancelled rows are never sent ---------------------------------------
  console.log('\nSupersession');

  await enqueueNotification(null, {
    type: 'APPOINTMENT_REMINDER',
    recipientEmail: `${TAG}.cancelled@example.test`,
    subject: 'Should never send',
    dedupeKey: `${TAG}:cancelled`,
    payload: {},
  });
  await prisma.notificationOutbox.update({
    where: { dedupeKey: `${TAG}:cancelled` },
    data: { status: 'CANCELLED' },
  });
  await runOutboxPass({ batchSize: 10 });
  const cancelled = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:cancelled` },
  });
  check('CANCELLED rows are not claimed', cancelled.status === 'CANCELLED');
  check('CANCELLED rows never get sentAt', cancelled.sentAt === null);

  // --- scheduling ----------------------------------------------------------
  console.log('\nScheduling');

  await enqueueNotification(null, {
    type: 'APPOINTMENT_REMINDER',
    recipientEmail: `${TAG}.future@example.test`,
    subject: 'Not due yet',
    dedupeKey: `${TAG}:future`,
    payload: {},
    notBefore: new Date(Date.now() + 3_600_000),
  });
  await runOutboxPass({ batchSize: 10 });
  const future = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:future` },
  });
  check('future-dated rows are not claimed early', future.status === 'PENDING', future.status);
  check('attempt counter untouched', future.attempts === 0, `attempts=${future.attempts}`);

  return { TAG };
}

main()
  .then(async (ctx) => {
    const { runPart2 } = await import('./verify-notifications2.js');
    await runPart2({ check, prisma, ctx, runOutboxPass, runReminderPass, retryDeadLetters });
    const { runPart3 } = await import('./verify-notifications3.js');
    await runPart3({ check, prisma, runOutboxPass, runReminderPass });
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\nnotification verification crashed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
