/**
 * End-to-end verification of Part 3 booking, driven entirely through the HTTP
 * API so it exercises the real request path, not the service layer directly.
 *
 * Requires the server to be running.  node scripts/verify-booking.js
 */
import { utcFromLocal, addDaysToKey, dateKey } from '../src/lib/time.js';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000';
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

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, body: json };
}

async function makePatient(stamp, n) {
  const r = await api('POST', '/api/auth/register', {
    body: {
      email: `book.p${n}.${stamp}@example.test`,
      password: 'Passw0rdTest',
      fullName: `Booking Patient ${n}`,
    },
  });
  return { token: r.body?.tokens?.accessToken, email: r.body?.user?.email };
}

export async function run() {
  const stamp = Date.now();
  console.log(`\nBooking verification against ${BASE}\n`);

  const admin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@clinic.test', password: 'Password123!' },
  });
  const adminToken = admin.body?.tokens?.accessToken;

  // A doctor available every day, 09:00-17:00, 30-minute slots.
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    startTime: '09:00',
    endTime: '17:00',
  }));

  const doc = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.booking.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Booking Test',
      specialisation: 'Booking Testing',
      slotDurationMin: 30,
      bufferMin: 0,
      workingHours: everyDay,
    },
  });
  const doctorId = doc.body?.id;
  check('test doctor created', doc.status === 201, JSON.stringify(doc.body).slice(0, 150));

  const patients = [];
  for (let i = 0; i < 8; i += 1) patients.push(await makePatient(stamp, i));
  check('8 test patients registered', patients.every((p) => p.token));

  // --- availability --------------------------------------------------------
  console.log('\nAvailability');

  const day = addDaysToKey(dateKey(new Date()), 7);
  const avail = await api('GET', `/api/doctors/${doctorId}/availability?date=${day}`, {
    token: patients[0].token,
  });
  check('availability -> 200', avail.status === 200, `got ${avail.status}`);

  const slots = avail.body?.days?.[0]?.slots ?? [];
  // 09:00-17:00 = 8 hours, 30-minute slots, no buffer => 16 slots
  check('16 slots for an 8-hour day at 30min', slots.length === 16, `got ${slots.length}`);
  check('first slot is 09:00 local', slots[0]?.localTime === '09:00', slots[0]?.localTime);
  check('last slot is 16:30 local', slots.at(-1)?.localTime === '16:30', slots.at(-1)?.localTime);

  // --- the race ------------------------------------------------------------
  console.log('\nConcurrent booking (the headline requirement)');

  const target = utcFromLocal(day, '10:00');
  const results = await Promise.all(
    patients.map((p) =>
      api('POST', '/api/appointments/hold', {
        token: p.token,
        body: { doctorId, slotStart: target.toISOString() },
      })
    )
  );

  const held = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  check('exactly one hold succeeded', held.length === 1, `${held.length} succeeded`);
  check(
    'the rest got 409 Conflict',
    conflicts.length === patients.length - 1,
    `${conflicts.length} conflicts of ${patients.length - 1}`
  );
  check(
    '409 carries a usable error code',
    conflicts[0]?.body?.error?.code === 'SLOT_UNAVAILABLE',
    conflicts[0]?.body?.error?.code
  );

  const winnerIdx = results.findIndex((r) => r.status === 201);
  const winner = patients[winnerIdx];
  const appointmentId = held[0]?.body?.id;
  check('hold returns a TTL', typeof held[0]?.body?.holdExpiresInSeconds === 'number');
  check('hold status is HELD', held[0]?.body?.status === 'HELD');

  const availAfterHold = await api('GET', `/api/doctors/${doctorId}/availability?date=${day}`, {
    token: patients[0].token,
  });
  const slotsAfter = availAfterHold.body?.days?.[0]?.slots ?? [];
  check(
    'held slot disappears from availability',
    !slotsAfter.some((s) => s.localTime === '10:00'),
    'still listed'
  );
  check('other slots unaffected', slotsAfter.length === 15, `got ${slotsAfter.length}`);

  return { adminToken, doctorId, day, winner, appointmentId, patients, stamp };
}

run()
  .then(async (ctx) => {
    const { runPart2 } = await import('./verify-booking2.js');
    return runPart2({ api, check, ctx });
  })
  .then(async (ctx) => {
    const { runPart3 } = await import('./verify-booking3.js');
    return runPart3({ api, check, ctx });
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\nbooking verification crashed:', e);
    process.exit(1);
  });
