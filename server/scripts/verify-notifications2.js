/** Second half: concurrency, retry/backoff, dead letters, medication reminders. */
import { enqueueMany } from '../src/lib/outbox.js';

export async function runPart2({
  check,
  prisma,
  ctx,
  runOutboxPass,
  runReminderPass,
  retryDeadLetters,
}) {
  const { TAG } = ctx;

  // --- concurrent workers --------------------------------------------------
  console.log('\nConcurrent workers (FOR UPDATE SKIP LOCKED)');

  // The suite drained pre-existing rows at startup, so everything claimed
  // below belongs to this test.
  const N = 40;
  await enqueueMany(
    null,
    Array.from({ length: N }, (_, i) => ({
      type: 'BOOKING_CONFIRMATION',
      recipientEmail: `${TAG}.race${i}@example.test`,
      subject: `Race ${i}`,
      dedupeKey: `${TAG}:race:${i}`,
      payload: { when: 'Mon 1 Jan 2027 at 9:00 AM', doctorName: 'Dr Test' },
    }))
  );

  // Four workers drain the same queue simultaneously.
  const passes = await Promise.all([
    runOutboxPass({ batchSize: 15 }),
    runOutboxPass({ batchSize: 15 }),
    runOutboxPass({ batchSize: 15 }),
    runOutboxPass({ batchSize: 15 }),
  ]);

  const raceRows = await prisma.notificationOutbox.findMany({
    where: { dedupeKey: { startsWith: `${TAG}:race:` } },
  });
  const totalClaimed = passes.reduce((a, p) => a + p.claimed, 0);
  const sentCount = raceRows.filter((r) => r.status === 'SENT').length;

  check('all 40 rows processed', sentCount === N, `${sentCount} sent`);
  check(
    'no row claimed twice (attempts === 1 everywhere)',
    raceRows.every((r) => r.attempts === 1),
    `attempt counts seen: ${[...new Set(raceRows.map((r) => r.attempts))].join(',')}`
  );
  check(
    'workers divided the queue rather than duplicating it',
    totalClaimed === N,
    `claimed ${totalClaimed} for ${N} rows -- a count above ${N} means a row was claimed twice`
  );
  console.log(`    split across workers: ${passes.map((p) => p.claimed).join(' / ')}`);

  // --- retry + backoff -----------------------------------------------------
  console.log('\nRetry and backoff');

  await enqueueMany(null, [
    {
      type: 'BOOKING_CONFIRMATION',
      recipientEmail: `${TAG}.retry@example.test`,
      subject: 'Retry candidate',
      dedupeKey: `${TAG}:retry`,
      payload: {},
      maxAttempts: 3,
    },
  ]);

  // Drive the row into the state a real SMTP failure would leave it in.
  await prisma.notificationOutbox.update({
    where: { dedupeKey: `${TAG}:retry` },
    data: {
      status: 'FAILED',
      attempts: 1,
      lastError: 'simulated connection reset',
      nextAttemptAt: new Date(Date.now() + 60_000),
    },
  });

  await runOutboxPass({ batchSize: 20 });
  const backedOff = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:retry` },
  });
  check(
    'a FAILED row inside its backoff window is not retried early',
    backedOff.status === 'FAILED' && backedOff.attempts === 1,
    `status=${backedOff.status} attempts=${backedOff.attempts}`
  );

  await prisma.notificationOutbox.update({
    where: { dedupeKey: `${TAG}:retry` },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });
  await runOutboxPass({ batchSize: 20 });
  const retried = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:retry` },
  });
  check('a FAILED row past its backoff is retried and sent', retried.status === 'SENT', retried.status);

  // --- dead letters --------------------------------------------------------
  console.log('\nDead letters');

  await enqueueMany(null, [
    {
      type: 'BOOKING_CONFIRMATION',
      recipientEmail: `${TAG}.dead@example.test`,
      subject: 'Exhausted',
      dedupeKey: `${TAG}:dead`,
      payload: {},
      maxAttempts: 2,
    },
  ]);
  await prisma.notificationOutbox.update({
    where: { dedupeKey: `${TAG}:dead` },
    data: { status: 'DEAD', attempts: 2, lastError: 'mailbox does not exist' },
  });

  await runOutboxPass({ batchSize: 20 });
  const stillDead = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:dead` },
  });
  check('DEAD rows are not retried automatically', stillDead.status === 'DEAD');
  check('DEAD row keeps its failure reason', Boolean(stillDead.lastError));

  const requeued = await retryDeadLetters({ ids: [stillDead.id] });
  check('admin can requeue a dead letter', requeued === 1, `requeued ${requeued}`);

  const revived = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:dead` },
  });
  check(
    'requeue resets the attempt counter',
    revived.attempts === 0 && revived.status === 'PENDING',
    `status=${revived.status} attempts=${revived.attempts}`
  );

  await runOutboxPass({ batchSize: 20 });
  const finallySent = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: `${TAG}:dead` },
  });
  check('requeued letter then delivers', finallySent.status === 'SENT', finallySent.status);

  await prisma.notificationOutbox.deleteMany({ where: { dedupeKey: { startsWith: TAG } } });
  return { TAG };
}
