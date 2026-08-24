import { prisma } from '../lib/prisma.js';
import { enqueueMany } from '../lib/outbox.js';
import { logger } from '../lib/logger.js';

const log = logger.child('reminders');

/**
 * Promotes due medication reminders into outbox rows.
 *
 * This job does NOT send anything. It only translates "this dose is due" into
 * "this email should exist", and hands delivery to the outbox worker. Keeping
 * the two apart means reminders inherit the outbox's retry, backoff and
 * dead-letter behaviour for free, rather than reimplementing them.
 *
 * A dose is due when scheduledAt has passed. Doses missed while the worker was
 * down still send, just late - a late reminder is more useful than none. Doses
 * older than the grace window are abandoned, because "take your 9am tablet"
 * arriving two days later is noise at best and misleading at worst.
 */
const GRACE_WINDOW_HOURS = 6;

export async function runReminderPass({ batchSize = 50 } = {}) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - GRACE_WINDOW_HOURS * 3_600_000);

  // Abandon anything too old to be actionable.
  const stale = await prisma.medicationReminder.updateMany({
    where: { status: 'PENDING', scheduledAt: { lt: cutoff } },
    data: { status: 'CANCELLED', lastError: 'Missed by more than the grace window' },
  });
  if (stale.count > 0) log.warn('abandoned stale reminders', { count: stale.count });

  const due = await prisma.medicationReminder.findMany({
    where: {
      status: 'PENDING',
      scheduledAt: { lte: now, gte: cutoff },
    },
    orderBy: { scheduledAt: 'asc' },
    take: batchSize,
    include: {
      prescriptionItem: true,
      patient: { include: { user: { select: { id: true, email: true, fullName: true } } } },
    },
  });

  if (due.length === 0) return { due: 0, queued: 0 };

  let queued = 0;

  for (const reminder of due) {
    const { prescriptionItem: item, patient } = reminder;

    try {
      await prisma.$transaction(async (tx) => {
        // Claim the reminder first, guarded on its current status, so two
        // concurrent passes cannot both enqueue the same dose.
        const claimed = await tx.medicationReminder.updateMany({
          where: { id: reminder.id, status: 'PENDING' },
          data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } },
        });
        if (claimed.count === 0) return;

        await enqueueMany(tx, [
          {
            type: 'MEDICATION_REMINDER',
            recipientUserId: patient.user.id,
            recipientEmail: patient.user.email,
            recipientName: patient.user.fullName,
            subject: `Reminder: take your ${item.medicationName}`,
            // One dose, one dedupe key - a replayed pass cannot double-send.
            dedupeKey: `MEDICATION_REMINDER:${reminder.id}`,
            payload: {
              medicationName: item.medicationName,
              dosage: item.dosage,
              instructions: item.instructions,
              scheduledAt: reminder.scheduledAt.toISOString(),
            },
          },
        ]);
        queued += 1;
      });
    } catch (e) {
      // Leave it PENDING so the next pass retries it.
      await prisma.medicationReminder.update({
        where: { id: reminder.id },
        data: { lastError: String(e.message).slice(0, 300) },
      });
      log.error('failed to queue reminder', { id: reminder.id, error: e.message });
    }
  }

  log.info('reminder pass complete', { due: due.length, queued });
  return { due: due.length, queued };
}

export function startReminderWorker({ intervalMs = 60_000, batchSize = 50 } = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminderPass({ batchSize });
    } catch (e) {
      log.error('reminder pass failed', { error: e.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  log.info('reminder worker started', { intervalMs, batchSize });
  return () => clearInterval(timer);
}
