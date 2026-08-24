/** Second half of the booking verification: confirm, cancel, reschedule, RBAC. */
import { utcFromLocal } from '../src/lib/time.js';

export async function runPart2({ api, check, ctx }) {
  const { adminToken, doctorId, day, winner, appointmentId, patients } = ctx;

  // --- confirm -------------------------------------------------------------
  console.log('\nConfirm flow');

  const tooShort = await api('POST', `/api/appointments/${appointmentId}/confirm`, {
    token: winner.token,
    body: { symptomsText: 'hurts' },
  });
  check('symptom text under 10 chars -> 400', tooShort.status === 400, `got ${tooShort.status}`);

  const wrongPatient = await api('POST', `/api/appointments/${appointmentId}/confirm`, {
    token: patients.find((p) => p !== winner).token,
    body: { symptomsText: 'Persistent headache for three days with light sensitivity.' },
  });
  check('confirming someone else hold -> 403', wrongPatient.status === 403, `got ${wrongPatient.status}`);

  const confirmed = await api('POST', `/api/appointments/${appointmentId}/confirm`, {
    token: winner.token,
    body: {
      symptomsText: 'Persistent headache for three days with light sensitivity and nausea.',
      durationDays: 3,
      severity: 7,
      currentMedications: 'Paracetamol 500mg as needed',
    },
  });
  check('confirm -> 200', confirmed.status === 200, JSON.stringify(confirmed.body).slice(0, 150));
  check('status now CONFIRMED', confirmed.body?.status === 'CONFIRMED');
  check('hold TTL cleared', confirmed.body?.holdExpiresAt === null);

  const doubleConfirm = await api('POST', `/api/appointments/${appointmentId}/confirm`, {
    token: winner.token,
    body: { symptomsText: 'Trying to confirm a second time to check idempotency.' },
  });
  check('double confirm -> 409', doubleConfirm.status === 409, `got ${doubleConfirm.status}`);

  // --- patient overlap -----------------------------------------------------
  console.log('\nPatient-side conflicts');

  const otherDoc = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.other.${Date.now()}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Other',
      specialisation: 'Booking Testing',
      slotDurationMin: 30,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        startTime: '09:00',
        endTime: '17:00',
      })),
    },
  });
  const clash = await api('POST', '/api/appointments/hold', {
    token: winner.token,
    body: { doctorId: otherDoc.body?.id, slotStart: utcFromLocal(day, '10:00').toISOString() },
  });
  check(
    'same patient, same time, different doctor -> 409',
    clash.status === 409,
    `got ${clash.status}`
  );

  // --- hold quota ----------------------------------------------------------
  const quotaPatient = patients[1];
  const times = ['11:00', '11:30', '12:00', '12:30'];
  const quotaResults = [];
  for (const t of times) {
    quotaResults.push(
      await api('POST', '/api/appointments/hold', {
        token: quotaPatient.token,
        body: { doctorId, slotStart: utcFromLocal(day, t).toISOString() },
      })
    );
  }
  check(
    'concurrent hold quota enforced at 3',
    quotaResults.filter((r) => r.status === 201).length === 3 && quotaResults[3].status === 409,
    quotaResults.map((r) => r.status).join(',')
  );

  // --- invalid slots -------------------------------------------------------
  console.log('\nSlot validation');

  const offGrid = await api('POST', '/api/appointments/hold', {
    token: patients[2].token,
    body: { doctorId, slotStart: utcFromLocal(day, '10:07').toISOString() },
  });
  check('off-grid time -> 400', offGrid.status === 400, `got ${offGrid.status}`);

  const outOfHours = await api('POST', '/api/appointments/hold', {
    token: patients[2].token,
    body: { doctorId, slotStart: utcFromLocal(day, '20:00').toISOString() },
  });
  check('outside working hours -> 400', outOfHours.status === 400, `got ${outOfHours.status}`);

  const past = await api('POST', '/api/appointments/hold', {
    token: patients[2].token,
    body: { doctorId, slotStart: new Date(Date.now() - 86_400_000).toISOString() },
  });
  check('past slot -> 400', past.status === 400, `got ${past.status}`);

  // --- RBAC on read --------------------------------------------------------
  console.log('\nAccess control');

  const stranger = await api('GET', `/api/appointments/${appointmentId}`, {
    token: patients[3].token,
  });
  check('unrelated patient reading -> 403', stranger.status === 403, `got ${stranger.status}`);

  const ownerView = await api('GET', `/api/appointments/${appointmentId}`, {
    token: winner.token,
  });
  check('owner can read', ownerView.status === 200);
  check(
    'patient does not receive the pre-visit summary',
    !('preVisitSummary' in (ownerView.body ?? {})),
    'preVisitSummary leaked to patient'
  );
  check('patient sees their own symptom report', ownerView.body?.symptomReport !== null);

  const adminView = await api('GET', `/api/appointments/${appointmentId}`, { token: adminToken });
  check('admin sees the pre-visit summary slot', 'preVisitSummary' in (adminView.body ?? {}));
  check(
    'pre-visit summary is PENDING awaiting Part 4',
    adminView.body?.preVisitSummary?.status === 'PENDING',
    adminView.body?.preVisitSummary?.status
  );

  // The race winner is whichever request Postgres let through, so resolve the
  // caller's real name rather than assuming which patient it was.
  const whoami = await api('GET', '/api/auth/me', { token: winner.token });
  const mine = await api('GET', '/api/appointments?upcoming=true', { token: winner.token });
  check('list scoped to caller', mine.status === 200 && mine.body?.data?.length >= 1);
  check(
    'list contains only own appointments',
    (mine.body?.data ?? []).every((a) => a.patient?.fullName === whoami.body?.fullName),
    `caller is ${whoami.body?.fullName}, list had ` +
      [...new Set((mine.body?.data ?? []).map((a) => a.patient?.fullName))].join(', ')
  );

  return { appointmentId, winner, doctorId, day, adminToken, patients };
}
