import { prisma } from '../lib/prisma.js';
import { createEvent, deleteEvent, calendarEnabled } from '../lib/google/calendar.js';
import { logger } from '../lib/logger.js';

const log = logger.child('calendar-sync');
const MAX_ATTEMPTS = 5;

/**
 * Reconciling sync, not an event stream.
 *
 * Each CalendarEvent row records what Google currently holds; the appointment
 * records what it SHOULD hold. The job makes the former match the latter, so
 * cancellation and rescheduling need no dedicated calendar hooks - the desired
 * state simply changes and the next pass converges. A missed pass self-heals.
 */
function desiredState(appointment) {
  return ['HELD', 'CONFIRMED', 'COMPLETED'].includes(appointment.status) ? 'PRESENT' : 'ABSENT';
}

export async function runCalendarPass({ batchSize = 20 } = {}) {
  if (!calendarEnabled()) return { skipped: true, synced: 0 };

  const rows = await prisma.calendarEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS } },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
    include: {
      appointment: {
        include: {
          doctor: { include: { user: { select: { fullName: true } } } },
          patient: { include: { user: { select: { fullName: true } } } },
        },
      },
    },
  });

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    const appt = row.appointment;
    const want = desiredState(appt);

    try {
      if (want === 'PRESENT' && !row.externalEventId) {
        const eventId = await createEvent(row.userId, {
          appointment: appt,
          doctorName: appt.doctor.user.fullName,
          patientName: appt.patient.user.fullName,
          forDoctor: row.userId === appt.doctor.userId,
        });

        // null means the user has not connected a calendar - not a failure.
        await prisma.calendarEvent.update({
          where: { id: row.id },
          data: eventId
            ? { externalEventId: eventId, status: 'SYNCED', lastSyncedAt: new Date(), lastError: null }
            : { status: 'SYNCED', lastSyncedAt: new Date(), lastError: 'No calendar connected' },
        });
        synced += 1;
      } else if (want === 'ABSENT' && row.externalEventId) {
        await deleteEvent(row.userId, row.externalEventId);
        await prisma.calendarEvent.update({
          where: { id: row.id },
          data: { status: 'DELETED', externalEventId: null, lastSyncedAt: new Date() },
        });
        synced += 1;
      } else {
        // Already in the desired state.
        await prisma.calendarEvent.update({
          where: { id: row.id },
          data: { status: want === 'ABSENT' ? 'DELETED' : 'SYNCED', lastSyncedAt: new Date() },
        });
        synced += 1;
      }
    } catch (e) {
      failed += 1;
      const attempts = row.attempts + 1;
      await prisma.calendarEvent.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          attempts,
          lastError: String(e.message).slice(0, 500),
        },
      });
      log.warn('calendar sync failed', { id: row.id, attempts, error: e.message.slice(0, 160) });
    }
  }

  if (rows.length) log.info('calendar pass complete', { processed: rows.length, synced, failed });
  return { processed: rows.length, synced, failed };
}

export function startCalendarWorker({ intervalMs = 30_000 } = {}) {
  if (!calendarEnabled()) {
    log.info('google calendar disabled - worker not started');
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runCalendarPass();
    } catch (e) {
      log.error('calendar pass failed', { error: e.message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  log.info('calendar worker started', { intervalMs });
  return () => clearInterval(timer);
}
