import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Transactional outbox - the write half.
 *
 * Callers enqueue inside the SAME transaction as the business change, so it is
 * impossible to cancel an appointment without also queuing its notification, or
 * to queue a notification for a cancellation that rolled back.
 *
 * The worker that drains these rows lands in Part 5; rows simply wait as
 * PENDING until then. That decoupling is the whole point of the pattern.
 *
 * `dedupeKey` is the natural key of the business event. Enqueueing the same
 * event twice is a no-op, which makes every caller safely retryable.
 */
export async function enqueueNotification(tx, notification) {
  const {
    type,
    recipientEmail,
    recipientUserId = null,
    recipientName = null,
    subject,
    payload = {},
    dedupeKey,
    appointmentId = null,
    maxAttempts = 5,
    notBefore = null,
  } = notification;

  if (!dedupeKey) throw new Error('enqueueNotification requires a dedupeKey');
  if (!recipientEmail) throw new Error(`enqueueNotification(${type}) requires a recipientEmail`);

  const client = tx ?? prisma;

  // createMany + skipDuplicates gives idempotency without a round trip to check
  // first, and without a unique-violation error to swallow.
  const result = await client.notificationOutbox.createMany({
    data: [
      {
        type,
        recipientEmail,
        recipientUserId,
        recipientName,
        subject,
        payload,
        dedupeKey,
        appointmentId,
        maxAttempts,
        ...(notBefore ? { nextAttemptAt: notBefore } : {}),
      },
    ],
    skipDuplicates: true,
  });

  if (result.count === 0) {
    logger.debug('notification already queued, skipping', { type, dedupeKey });
  }
  return result.count === 1;
}

/** Enqueues several notifications atomically. Returns how many were new. */
export async function enqueueMany(tx, notifications) {
  const client = tx ?? prisma;
  if (notifications.length === 0) return 0;

  const { count } = await client.notificationOutbox.createMany({
    data: notifications.map((n) => ({
      type: n.type,
      recipientEmail: n.recipientEmail,
      recipientUserId: n.recipientUserId ?? null,
      recipientName: n.recipientName ?? null,
      subject: n.subject,
      payload: n.payload ?? {},
      dedupeKey: n.dedupeKey,
      appointmentId: n.appointmentId ?? null,
      maxAttempts: n.maxAttempts ?? 5,
      ...(n.notBefore ? { nextAttemptAt: n.notBefore } : {}),
    })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Cancels queued-but-unsent notifications for an appointment. Used when an
 * event is superseded - e.g. a reminder for an appointment that just got
 * cancelled must not go out.
 */
export async function cancelPending(tx, { appointmentId, types = null }) {
  const client = tx ?? prisma;
  const { count } = await client.notificationOutbox.updateMany({
    where: {
      appointmentId,
      status: { in: ['PENDING', 'FAILED'] },
      ...(types ? { type: { in: types } } : {}),
    },
    data: { status: 'CANCELLED' },
  });
  return count;
}
