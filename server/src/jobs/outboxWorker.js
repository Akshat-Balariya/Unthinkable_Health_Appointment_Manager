import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { sendMail } from '../lib/mail/transport.js';
import { renderNotification } from '../lib/mail/templates.js';
import { logger } from '../lib/logger.js';

const log = logger.child('outbox');

/**
 * Exponential backoff between delivery attempts: 1m, 4m, 9m, 16m, 25m.
 * Quadratic rather than doubling, so a five-attempt budget still spans an hour
 * without the last gap being most of a day.
 */
function nextAttemptDelayMs(attempts) {
  return Math.min(attempts ** 2, 60) * 60_000;
}

/**
 * Atomically claims a batch of due notifications.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes multiple worker processes safe: each
 * transaction locks the rows it selects and skips rows another worker already
 * holds, so two workers never claim the same notification and neither blocks
 * the other. Without SKIP LOCKED, a second worker would serialise behind the
 * first and the pool would be pointless.
 *
 * The attempt counter is incremented at CLAIM time, not at send time. A worker
 * that crashes mid-send therefore burns one attempt rather than retrying that
 * row forever - failing toward "gives up eventually" instead of "loops
 * indefinitely".
 */
async function claimBatch(limit, now = new Date()) {
  // Both sides of the comparison must be timezone-NAIVE UTC.
  //
  // Prisma maps DateTime to `timestamp WITHOUT time zone` holding UTC values,
  // but binds a JS Date as `timestamptz`. Comparing the two makes Postgres
  // reinterpret the naive column value in the session TimeZone: on a server set
  // to Asia/Kolkata a row due in 3 hours appears 2.5 hours overdue, so the
  // worker fires reminders early and ignores backoff entirely. Worse, the drift
  // is zero on a UTC server, so the bug hides in one environment and appears in
  // another.
  //
  // `AT TIME ZONE 'UTC'` converts the bound timestamptz back to a naive UTC
  // timestamp, matching the column exactly. It sits on the constant side of the
  // comparison, so the partial index on "nextAttemptAt" is still usable.
  return prisma.$queryRaw`
    UPDATE notification_outbox
       SET status = 'PROCESSING',
           attempts = attempts + 1,
           "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
     WHERE id IN (
       SELECT id
         FROM notification_outbox
        WHERE status IN ('PENDING', 'FAILED')
          AND "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "nextAttemptAt" ASC
          FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
    RETURNING id, type, "recipientEmail", "recipientName", subject, payload,
              attempts, "maxAttempts", "dedupeKey", "appointmentId";
  `;
}

async function markSent(row, messageId) {
  await prisma.notificationOutbox.update({
    where: { id: row.id },
    data: {
      status: 'SENT',
      sentAt: new Date(),
      providerMessageId: messageId,
      lastError: null,
    },
  });
}

async function markFailed(row, error) {
  const permanent = error.retryable === false;
  const exhausted = row.attempts >= row.maxAttempts;
  const dead = permanent || exhausted;

  await prisma.notificationOutbox.update({
    where: { id: row.id },
    data: {
      status: dead ? 'DEAD' : 'FAILED',
      lastError: String(error.message ?? error).slice(0, 500),
      nextAttemptAt: dead
        ? new Date()
        : new Date(Date.now() + nextAttemptDelayMs(row.attempts)),
    },
  });

  if (dead) {
    // DEAD is a human's problem, not the worker's. Logged loudly so it is
    // visible in whatever the host aggregates, and queryable via the admin API.
    log.error('notification permanently failed', {
      id: row.id,
      type: row.type,
      to: row.recipientEmail,
      attempts: row.attempts,
      reason: permanent ? 'non-retryable' : 'attempts exhausted',
      error: String(error.message ?? error).slice(0, 200),
    });
  }
}

/**
 * Drains one batch. Returns counts rather than throwing, so a single bad
 * recipient cannot abort the pass for everyone behind it in the queue.
 */
export async function runOutboxPass({ batchSize = env.WORKER_BATCH_SIZE } = {}) {
  const claimed = await claimBatch(batchSize);
  if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      const { html, text } = renderNotification(row.type, row.payload ?? {});
      const { messageId } = await sendMail({
        to: row.recipientName
          ? `"${row.recipientName}" <${row.recipientEmail}>`
          : row.recipientEmail,
        subject: row.subject,
        html,
        text,
      });
      await markSent(row, messageId);
      sent += 1;
    } catch (err) {
      await markFailed(row, err);
      failed += 1;
    }
  }

  log.info('outbox pass complete', { claimed: claimed.length, sent, failed });
  return { claimed: claimed.length, sent, failed };
}

/**
 * Requeues DEAD notifications for another try. Manual, admin-triggered - a
 * dead letter usually means something needs fixing first, so retrying
 * automatically would just re-fail on a schedule.
 */
export async function retryDeadLetters({ ids = null, type = null } = {}) {
  const { count } = await prisma.notificationOutbox.updateMany({
    where: {
      status: 'DEAD',
      ...(ids ? { id: { in: ids } } : {}),
      ...(type ? { type } : {}),
    },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  log.info('dead letters requeued', { count });
  return count;
}

export function startOutboxWorker({
  intervalMs = env.WORKER_POLL_INTERVAL_MS,
  batchSize = env.WORKER_BATCH_SIZE,
} = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Keep draining while the queue is full, so a backlog clears in one
      // wake-up instead of one batch per poll interval.
      let guard = 0;
      let result;
      do {
        result = await runOutboxPass({ batchSize });
        guard += 1;
      } while (result.claimed === batchSize && guard < 10);
    } catch (e) {
      log.error('outbox pass failed', { error: e.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  log.info('outbox worker started', { intervalMs, batchSize });
  return () => clearInterval(timer);
}
