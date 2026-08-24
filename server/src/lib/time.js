import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { env } from '../config/env.js';

/**
 * Timezone policy for the whole system:
 *
 *   - Working hours and leave times are WALL-CLOCK strings ("09:00") in the
 *     clinic's timezone. They are not instants and must never be stored as one.
 *   - `DoctorLeave.leaveDate` is a calendar date in the clinic's timezone.
 *   - `Appointment.slotStart/slotEnd` are absolute UTC instants.
 *
 * Everything that crosses between those two worlds goes through this module, so
 * DST transitions and server-locale differences are handled in exactly one place.
 */

export const clinicTimezone = () => env.CLINIC_TIMEZONE;

/** "09:30" -> 570 */
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 570 -> "09:30" */
export function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "2025-03-14" for a Date, as seen in the clinic's timezone. */
export function dateKey(date, tz = clinicTimezone()) {
  return formatInTimeZone(date, tz, 'yyyy-MM-dd');
}

/** 0 = Sunday .. 6 = Saturday, as seen in the clinic's timezone. */
export function dayOfWeekInZone(date, tz = clinicTimezone()) {
  return Number(formatInTimeZone(date, tz, 'i')) % 7; // date-fns 'i' is 1=Mon..7=Sun
}

/**
 * Combines a calendar day with a wall-clock time in `tz` and returns the
 * matching UTC instant.
 *
 *   utcFromLocal('2025-03-14', '09:00', 'Asia/Kolkata') -> 2025-03-14T03:30:00Z
 */
export function utcFromLocal(dayKey, hhmm, tz = clinicTimezone()) {
  const key = typeof dayKey === 'string' ? dayKey : dateKey(dayKey, tz);
  return fromZonedTime(`${key}T${hhmm}:00`, tz);
}

/** The [start, end) UTC instants spanning one local calendar day. */
export function localDayRangeUtc(dayKey, tz = clinicTimezone()) {
  const key = typeof dayKey === 'string' ? dayKey : dateKey(dayKey, tz);
  const start = fromZonedTime(`${key}T00:00:00`, tz);
  // Add 24h in local terms by moving to the next calendar day, which stays
  // correct across a DST boundary where the day is 23 or 25 hours long.
  const [y, m, d] = key.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const end = fromZonedTime(`${nextKey}T00:00:00`, tz);
  return { start, end };
}

/**
 * UTC range covered by a leave. A whole-day leave spans the local day; a
 * partial leave spans only the given wall-clock window.
 */
export function leaveRangeUtc({ leaveDate, startTime, endTime }, tz = clinicTimezone()) {
  const key = dateKey(leaveDate, 'UTC'); // leaveDate is a @db.Date - already midnight UTC
  if (!startTime || !endTime) return localDayRangeUtc(key, tz);
  return { start: utcFromLocal(key, startTime, tz), end: utcFromLocal(key, endTime, tz) };
}

/** Human-readable rendering for emails and calendar summaries. */
export function formatForHuman(date, tz = clinicTimezone()) {
  return formatInTimeZone(date, tz, "EEE d MMM yyyy 'at' h:mm a");
}

export function formatTimeOnly(date, tz = clinicTimezone()) {
  return formatInTimeZone(date, tz, 'h:mm a');
}

/** Adds days to a local calendar day key without tripping over DST. */
export function addDaysToKey(dayKey, days) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export { toZonedTime, fromZonedTime, formatInTimeZone };
