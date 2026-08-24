/** Third part: cancellation, reschedule, leave interaction, outbox side effects. */
import { utcFromLocal, addDaysToKey } from '../src/lib/time.js';

export async function runPart3({ api, check, ctx }) {
  const { adminToken, doctorId, day, winner, appointmentId, patients } = ctx;

  // --- reschedule ----------------------------------------------------------
  console.log('\nReschedule');

  const newSlot = utcFromLocal(day, '14:00');
  const moved = await api('POST', `/api/appointments/${appointmentId}/reschedule`, {
    token: winner.token,
    body: { newSlotStart: newSlot.toISOString(), reason: 'Work conflict' },
  });
  check('reschedule -> 200', moved.status === 200, JSON.stringify(moved.body).slice(0, 150));
  check('new appointment CONFIRMED', moved.body?.status === 'CONFIRMED');
  check('new slot time applied', new Date(moved.body?.slotStart).getTime() === newSlot.getTime());

  const oldOne = await api('GET', `/api/appointments/${appointmentId}`, { token: winner.token });
  check('original marked CANCELLED', oldOne.body?.status === 'CANCELLED', oldOne.body?.status);

  const freed = await api('GET', `/api/doctors/${doctorId}/availability?date=${day}`, {
    token: patients[0].token,
  });
  const freedSlots = freed.body?.days?.[0]?.slots ?? [];
  check(
    'vacated 10:00 slot is bookable again',
    freedSlots.some((s) => s.localTime === '10:00'),
    'still missing'
  );
  check(
    'new 14:00 slot now taken',
    !freedSlots.some((s) => s.localTime === '14:00'),
    'still listed'
  );

  const rescheduledId = moved.body?.id;

  // Rescheduling onto an occupied slot must not destroy the current booking.
  const occupied = await api('POST', '/api/appointments/hold', {
    token: patients[4].token,
    body: { doctorId, slotStart: utcFromLocal(day, '15:00').toISOString() },
  });
  check('helper hold at 15:00 created', occupied.status === 201);

  const collide = await api('POST', `/api/appointments/${rescheduledId}/reschedule`, {
    token: winner.token,
    body: { newSlotStart: utcFromLocal(day, '15:00').toISOString() },
  });
  check('reschedule onto taken slot -> 409', collide.status === 409, `got ${collide.status}`);

  const survived = await api('GET', `/api/appointments/${rescheduledId}`, { token: winner.token });
  check(
    'failed reschedule left the original intact',
    survived.body?.status === 'CONFIRMED',
    `status is ${survived.body?.status}`
  );

  // --- cancellation --------------------------------------------------------
  console.log('\nCancellation');

  const cancelled = await api('POST', `/api/appointments/${rescheduledId}/cancel`, {
    token: winner.token,
    body: { reason: 'Feeling better' },
  });
  check('cancel -> 200', cancelled.status === 200, `got ${cancelled.status}`);
  check('status CANCELLED', cancelled.body?.status === 'CANCELLED');
  check('cancelledBy recorded', cancelled.body?.cancelledBy === 'PATIENT');

  const doubleCancel = await api('POST', `/api/appointments/${rescheduledId}/cancel`, {
    token: winner.token,
    body: {},
  });
  check('double cancel -> 409', doubleCancel.status === 409, `got ${doubleCancel.status}`);

  const afterCancel = await api('GET', `/api/doctors/${doctorId}/availability?date=${day}`, {
    token: patients[0].token,
  });
  check(
    'cancelled slot returns to availability',
    (afterCancel.body?.days?.[0]?.slots ?? []).some((s) => s.localTime === '14:00'),
    'not restored'
  );

  // --- leave interaction ---------------------------------------------------
  console.log('\nLeave vs availability');

  const leaveDay = addDaysToKey(day, 1);
  const leave = await api('POST', `/api/admin/doctors/${doctorId}/leaves`, {
    token: adminToken,
    body: { leaveDate: leaveDay, reason: 'Training day' },
  });
  check('leave created -> 201', leave.status === 201, `got ${leave.status}`);

  const onLeave = await api('GET', `/api/doctors/${doctorId}/availability?date=${leaveDay}`, {
    token: patients[0].token,
  });
  check('leave day reports onLeave', onLeave.body?.days?.[0]?.onLeave === true);
  check('leave day offers no slots', (onLeave.body?.days?.[0]?.slots ?? []).length === 0);

  const bookOnLeave = await api('POST', '/api/appointments/hold', {
    token: patients[5].token,
    body: { doctorId, slotStart: utcFromLocal(leaveDay, '10:00').toISOString() },
  });
  check('booking on a leave day -> 400', bookOnLeave.status === 400, `got ${bookOnLeave.status}`);

  // --- partial-day leave ---------------------------------------------------
  const partialDay = addDaysToKey(day, 2);
  await api('POST', `/api/admin/doctors/${doctorId}/leaves`, {
    token: adminToken,
    body: { leaveDate: partialDay, startTime: '09:00', endTime: '12:00', reason: 'Half day' },
  });
  const partial = await api('GET', `/api/doctors/${doctorId}/availability?date=${partialDay}`, {
    token: patients[0].token,
  });
  const pSlots = partial.body?.days?.[0]?.slots ?? [];
  check('partial leave keeps the day open', partial.body?.days?.[0]?.onLeave === false);
  check(
    'morning slots removed',
    !pSlots.some((s) => s.localTime < '12:00'),
    pSlots.slice(0, 3).map((s) => s.localTime).join(',')
  );
  check(
    'afternoon slots retained',
    pSlots.some((s) => s.localTime === '13:00'),
    'afternoon missing'
  );
}
