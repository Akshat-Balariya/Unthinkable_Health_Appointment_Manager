import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  dateKey,
  addDaysToKey,
  utcFromLocal,
  localDayRangeUtc,
  toMinutes,
  toHHMM,
  clinicTimezone,
} from '../../lib/time.js';

/**
 * Availability is COMPUTED, never stored.
 *
 * Materialising a slot table would mean regenerating it whenever a doctor edits
 * working hours or slot duration, and would drift from reality the moment that
 * job failed. Instead a slot exists if, and only if, it survives four filters:
 *
 *   1. it falls inside an active working-hour block for that weekday
 *   2. it does not overlap a leave window
 *   3. it does not overlap a HELD or CONFIRMED appointment
 *   4. it respects the doctor's minimum notice and maximum advance window
 *
 * The database guards from Part 1 remain the real authority: this function can
 * only ever be advisory, because another patient may book between the moment
 * these slots are rendered and the moment one is held.
 */

const MAX_RANGE_DAYS = 60;

/** Expands one working-hour block into candidate wall-clock slot starts. */
function slotStartsForBlock(block, slotDurationMin, bufferMin) {
  const starts = [];
  const blockStart = toMinutes(block.startTime);
  const blockEnd = toMinutes(block.endTime);
  const step = slotDurationMin + bufferMin;

  for (let t = blockStart; t + slotDurationMin <= blockEnd; t += step) {
    starts.push(toHHMM(t));
  }
  return starts;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

/**
 * Available slots for one doctor across a date range (inclusive, clinic-local
 * calendar days).
 */
export async function getAvailability(doctorId, { from, to } = {}) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, isActive: true, user: { isActive: true } },
    include: { workingHours: { where: { isActive: true } } },
  });
  if (!doctor) throw new NotFoundError('Doctor');

  const tz = clinicTimezone();
  const today = dateKey(new Date(), tz);
  const fromKey = from ? dateKey(from, 'UTC') : today;
  const toKey = to ? dateKey(to, 'UTC') : addDaysToKey(fromKey, 6);

  if (toKey < fromKey) throw new ValidationError('`to` must not be before `from`');

  // Never look further ahead than the doctor allows.
  const horizonKey = addDaysToKey(today, doctor.maxAdvanceDays);
  const effectiveTo = toKey > horizonKey ? horizonKey : toKey;
  const effectiveFrom = fromKey < today ? today : fromKey;

  const days = [];
  for (let k = effectiveFrom; k <= effectiveTo; k = addDaysToKey(k, 1)) {
    days.push(k);
    if (days.length > MAX_RANGE_DAYS) {
      throw new ValidationError(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
    }
  }
  if (days.length === 0) {
    return { doctorId, timezone: tz, slotDurationMin: doctor.slotDurationMin, days: [] };
  }

  // One query each for leaves and appointments across the whole range, rather
  // than per day.
  const rangeStart = localDayRangeUtc(days[0], tz).start;
  const rangeEnd = localDayRangeUtc(days[days.length - 1], tz).end;

  const [leaves, booked] = await Promise.all([
    prisma.doctorLeave.findMany({
      where: {
        doctorId,
        leaveDate: {
          gte: new Date(`${days[0]}T00:00:00Z`),
          lte: new Date(`${days[days.length - 1]}T00:00:00Z`),
        },
      },
    }),
    prisma.appointment.findMany({
      where: {
        doctorId,
        status: { in: ['HELD', 'CONFIRMED'] },
        slotStart: { lt: rangeEnd },
        slotEnd: { gt: rangeStart },
      },
      select: { slotStart: true, slotEnd: true },
    }),
  ]);

  const leavesByDay = new Map();
  for (const l of leaves) {
    const key = dateKey(l.leaveDate, 'UTC');
    if (!leavesByDay.has(key)) leavesByDay.set(key, []);
    leavesByDay.get(key).push(l);
  }

  const blocksByWeekday = new Map();
  for (const w of doctor.workingHours) {
    if (!blocksByWeekday.has(w.dayOfWeek)) blocksByWeekday.set(w.dayOfWeek, []);
    blocksByWeekday.get(w.dayOfWeek).push(w);
  }

  const notBefore = new Date(Date.now() + doctor.minNoticeMin * 60_000);

  const result = days.map((dayKeyStr) => {
    // Weekday of this calendar day in the clinic's zone. Derived from the key
    // itself so it cannot drift with server locale.
    const [y, m, d] = dayKeyStr.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    const blocks = blocksByWeekday.get(weekday) ?? [];
    const dayLeaves = leavesByDay.get(dayKeyStr) ?? [];

    // A whole-day leave short-circuits the day entirely.
    const fullDayLeave = dayLeaves.find((l) => !l.startTime || !l.endTime);
    if (fullDayLeave) {
      return {
        date: dayKeyStr,
        weekday,
        onLeave: true,
        leaveReason: fullDayLeave.reason ?? null,
        slots: [],
      };
    }

    const leaveRanges = dayLeaves.map((l) => ({
      start: utcFromLocal(dayKeyStr, l.startTime, tz),
      end: utcFromLocal(dayKeyStr, l.endTime, tz),
    }));

    const slots = [];
    for (const block of blocks) {
      for (const hhmm of slotStartsForBlock(block, doctor.slotDurationMin, doctor.bufferMin)) {
        const start = utcFromLocal(dayKeyStr, hhmm, tz);
        const end = new Date(start.getTime() + doctor.slotDurationMin * 60_000);

        if (start < notBefore) continue;
        if (leaveRanges.some((r) => overlaps(start, end, r.start, r.end))) continue;
        if (booked.some((b) => overlaps(start, end, b.slotStart, b.slotEnd))) continue;

        slots.push({ start: start.toISOString(), end: end.toISOString(), localTime: hhmm });
      }
    }

    slots.sort((a, b) => a.start.localeCompare(b.start));
    return { date: dayKeyStr, weekday, onLeave: false, slots };
  });

  return {
    doctorId,
    doctorName: undefined,
    timezone: tz,
    slotDurationMin: doctor.slotDurationMin,
    bufferMin: doctor.bufferMin,
    days: result,
  };
}


/** Wall-clock "HH:mm" of an instant, as seen in the clinic timezone. */
function wallClockIn(date, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Whether one specific slot is legitimately bookable.
 *
 * Booking calls this before inserting, so a nonsensical slot fails with a clear
 * message instead of a constraint violation. It is NOT the safety mechanism -
 * the database guards are, because another patient can book in the gap between
 * this check and the insert.
 */
export async function assertSlotIsBookable(doctorId, slotStart) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, isActive: true, user: { isActive: true } },
    include: { workingHours: { where: { isActive: true } } },
  });
  if (!doctor) throw new NotFoundError('Doctor');

  const tz = clinicTimezone();
  const dayKeyStr = dateKey(slotStart, tz);
  const [y, m, d] = dayKeyStr.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const slotEnd = new Date(slotStart.getTime() + doctor.slotDurationMin * 60_000);

  if (slotStart < new Date(Date.now() + doctor.minNoticeMin * 60_000)) {
    throw new ValidationError(
      `This doctor requires at least ${doctor.minNoticeMin} minutes notice`
    );
  }
  if (slotStart > new Date(Date.now() + doctor.maxAdvanceDays * 86_400_000)) {
    throw new ValidationError(
      `This doctor accepts bookings up to ${doctor.maxAdvanceDays} days ahead`
    );
  }

  // Must land exactly on the generated grid, not merely inside working hours.
  const validStarts = new Set(
    doctor.workingHours
      .filter((w) => w.dayOfWeek === weekday)
      .flatMap((b) => slotStartsForBlock(b, doctor.slotDurationMin, doctor.bufferMin))
  );
  if (!validStarts.has(wallClockIn(slotStart, tz))) {
    throw new ValidationError('That time is not one of this doctor’s bookable slots');
  }

  const leaves = await prisma.doctorLeave.findMany({
    where: { doctorId, leaveDate: new Date(`${dayKeyStr}T00:00:00Z`) },
  });
  for (const l of leaves) {
    if (!l.startTime || !l.endTime) {
      throw new ValidationError('The doctor is on leave that day');
    }
    const ls = utcFromLocal(dayKeyStr, l.startTime, tz);
    const le = utcFromLocal(dayKeyStr, l.endTime, tz);
    if (overlaps(slotStart, slotEnd, ls, le)) {
      throw new ValidationError('The doctor is on leave at that time');
    }
  }

  return { doctor, slotEnd };
}
