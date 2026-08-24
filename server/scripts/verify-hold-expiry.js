/**
 * Proves the slot-hold TTL mechanism.
 *
 * Holds are aged by rewriting holdExpiresAt directly, rather than sleeping for
 * the real 10-minute TTL. Everything else goes through the normal API.
 *
 * Requires the server to be running.  node scripts/verify-hold-expiry.js
 */
import { PrismaClient } from '@prisma/client';
import { utcFromLocal, addDaysToKey, dateKey } from '../src/lib/time.js';
import { expireStaleHolds } from '../src/modules/appointments/booking.service.js';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000';
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

async function main() {
  const stamp = Date.now();
  console.log(`\nHold expiry verification against ${BASE}\n`);

  const admin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@clinic.test', password: 'Password123!' },
  });
  const adminToken = admin.body?.tokens?.accessToken;

  const doc = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.hold.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Hold Test',
      specialisation: 'Hold Testing',
      slotDurationMin: 30,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        startTime: '09:00',
        endTime: '17:00',
      })),
    },
  });
  const doctorId = doc.body.id;

  const reg = async (n) =>
    (
      await api('POST', '/api/auth/register', {
        body: {
          email: `hold.p${n}.${stamp}@example.test`,
          password: 'Passw0rdTest',
          fullName: `Hold Patient ${n}`,
        },
      })
    ).body?.tokens?.accessToken;

  const alice = await reg('alice');
  const bob = await reg('bob');

  const day = addDaysToKey(dateKey(new Date()), 9);
  const slot = utcFromLocal(day, '11:00').toISOString();

  // --- Alice holds the slot ------------------------------------------------
  const held = await api('POST', '/api/appointments/hold', {
    token: alice,
    body: { doctorId, slotStart: slot },
  });
  check('Alice holds the slot', held.status === 201, `got ${held.status}`);
  const apptId = held.body.id;

  const bobBlocked = await api('POST', '/api/appointments/hold', {
    token: bob,
    body: { doctorId, slotStart: slot },
  });
  check('Bob is blocked while the hold is live', bobBlocked.status === 409, `got ${bobBlocked.status}`);

  // --- age the hold past its TTL -------------------------------------------
  await prisma.appointment.update({
    where: { id: apptId },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });
  console.log('\n  (hold aged past its TTL)\n');

  // --- confirming a lapsed hold must fail ----------------------------------
  const lateConfirm = await api('POST', `/api/appointments/${apptId}/confirm`, {
    token: alice,
    body: { symptomsText: 'Trying to confirm after the hold has already lapsed.' },
  });
  check('confirming a lapsed hold -> 409', lateConfirm.status === 409, `got ${lateConfirm.status}`);
  check(
    'error explains the hold expired',
    /expired/i.test(lateConfirm.body?.error?.message ?? ''),
    lateConfirm.body?.error?.message
  );

  const afterFailedConfirm = await prisma.appointment.findUnique({ where: { id: apptId } });
  check(
    'lapsed hold marked EXPIRED, not left HELD',
    afterFailedConfirm.status === 'EXPIRED',
    afterFailedConfirm.status
  );

  // --- the slot is free again ----------------------------------------------
  const bobRetry = await api('POST', '/api/appointments/hold', {
    token: bob,
    body: { doctorId, slotStart: slot },
  });
  check('Bob can now take the slot', bobRetry.status === 201, `got ${bobRetry.status}`);

  // --- inline reaping, independent of the sweeper --------------------------
  await prisma.appointment.update({
    where: { id: bobRetry.body.id },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });

  const aliceRetry = await api('POST', '/api/appointments/hold', {
    token: alice,
    body: { doctorId, slotStart: slot },
  });
  check(
    'a lapsed hold does not block a new booking even before the sweeper runs',
    aliceRetry.status === 201,
    `got ${aliceRetry.status} - inline reaping failed`
  );

  // --- the sweeper itself --------------------------------------------------
  const other = utcFromLocal(day, '12:00').toISOString();
  const stale = await api('POST', '/api/appointments/hold', {
    token: bob,
    body: { doctorId, slotStart: other },
  });
  await prisma.appointment.update({
    where: { id: stale.body.id },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });

  const swept = await expireStaleHolds();
  check('sweeper reports work done', swept >= 1, `swept ${swept}`);

  const sweptRow = await prisma.appointment.findUnique({ where: { id: stale.body.id } });
  check('sweeper moved it to EXPIRED', sweptRow.status === 'EXPIRED', sweptRow.status);

  const avail = await api('GET', `/api/doctors/${doctorId}/availability?date=${day}`, {
    token: alice,
  });
  const slots = avail.body?.days?.[0]?.slots ?? [];
  check(
    'swept slot is offered again',
    slots.some((s) => s.localTime === '12:00'),
    'still hidden'
  );
  check(
    'the live hold is still hidden',
    !slots.some((s) => s.localTime === '11:00'),
    'live hold leaked into availability'
  );

  // --- cleanup -------------------------------------------------------------
  const docUser = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  await prisma.appointment.deleteMany({ where: { doctorId } });
  await prisma.user.delete({ where: { id: docUser.userId } });
  console.log('\n  cleaned up');
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\nhold expiry verification crashed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
