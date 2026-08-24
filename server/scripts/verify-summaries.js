/**
 * End-to-end verification of Part 4: the full clinical lifecycle.
 *
 *   book -> confirm (symptoms) -> pre-visit summary -> visit notes
 *   -> medication reminders -> post-visit summary
 *
 * Runs against the configured LLM provider, so it makes real API calls.
 * Requires the server running.  node scripts/verify-summaries.js
 */
import { PrismaClient } from '@prisma/client';
import { utcFromLocal, addDaysToKey, dateKey } from '../src/lib/time.js';
import { runSummaryPass } from '../src/jobs/summaryJob.js';
import { activeLlmProvider } from '../src/config/env.js';

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
  console.log(`\nSummary lifecycle verification (provider: ${activeLlmProvider()})\n`);

  const admin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@clinic.test', password: 'Password123!' },
  });
  const adminToken = admin.body.tokens.accessToken;

  const doc = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.summary.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Summary Test',
      specialisation: 'Summary Testing',
      slotDurationMin: 30,
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        startTime: '09:00',
        endTime: '17:00',
      })),
    },
  });
  const doctorId = doc.body.id;
  const doctorLogin = await api('POST', '/api/auth/login', {
    body: { email: `dr.summary.${stamp}@clinic.test`, password: 'Passw0rdTest' },
  });
  const doctorToken = doctorLogin.body.tokens.accessToken;

  const patient = await api('POST', '/api/auth/register', {
    body: {
      email: `summary.patient.${stamp}@example.test`,
      password: 'Passw0rdTest',
      fullName: 'Summary Patient',
    },
  });
  const patientToken = patient.body.tokens.accessToken;

  // --- book + confirm ------------------------------------------------------
  console.log('Booking with symptoms');

  const day = addDaysToKey(dateKey(new Date()), 11);
  const held = await api('POST', '/api/appointments/hold', {
    token: patientToken,
    body: { doctorId, slotStart: utcFromLocal(day, '10:00').toISOString() },
  });
  const apptId = held.body.id;
  check('slot held', held.status === 201, `got ${held.status}`);

  const confirmed = await api('POST', `/api/appointments/${apptId}/confirm`, {
    token: patientToken,
    body: {
      symptomsText:
        'Severe throbbing headache on the right side for the past four days, worse in bright light, ' +
        'with nausea and one episode of vomiting. Over-the-counter painkillers are not helping.',
      durationDays: 4,
      severity: 8,
      currentMedications: 'Ibuprofen 400mg twice daily',
    },
  });
  check('booking confirmed', confirmed.status === 200, `got ${confirmed.status}`);

  const pendingSummary = await prisma.preVisitSummary.findUnique({
    where: { appointmentId: apptId },
  });
  check('pre-visit summary created PENDING', pendingSummary?.status === 'PENDING');
  check('confirm did not block on the LLM', pendingSummary?.generatedAt === null);

  // --- pre-visit generation ------------------------------------------------
  console.log('\nPre-visit summary generation');

  // Drive this appointment's summary directly rather than via runSummaryPass.
  // The worker is strictly FIFO across ALL pending rows, so relying on queue
  // position makes the test depend on how much unprocessed history exists.
  // This is the identical code path the worker invokes per row.
  const { generatePreVisitSummary } = await import('../src/modules/summaries/summaries.service.js');
  const t0 = Date.now();
  const genResult = await generatePreVisitSummary(apptId);
  console.log(`  (generation took ${Date.now() - t0}ms -> ${genResult.status})`);

  const preVisit = await api('GET', `/api/appointments/${apptId}/pre-visit-summary`, {
    token: doctorToken,
  });
  check('doctor can read the pre-visit summary', preVisit.status === 200, `got ${preVisit.status}`);
  check('status READY', preVisit.body?.status === 'READY', preVisit.body?.status);
  check(
    'urgency is one of LOW/MEDIUM/HIGH',
    ['LOW', 'MEDIUM', 'HIGH'].includes(preVisit.body?.urgencyLevel),
    preVisit.body?.urgencyLevel
  );
  check(
    'exactly three suggested questions',
    preVisit.body?.suggestedQuestions?.length === 3,
    `got ${preVisit.body?.suggestedQuestions?.length}`
  );
  check('chief complaint present', Boolean(preVisit.body?.chiefComplaint));
  check('provenance recorded', Boolean(preVisit.body?.model && preVisit.body?.promptVersion));
  check('raw symptom text also returned', Boolean(preVisit.body?.symptomReport?.symptomsText));

  console.log(`\n  urgency  : ${preVisit.body?.urgencyLevel}`);
  console.log(`  complaint: ${String(preVisit.body?.chiefComplaint).slice(0, 110)}...`);

  const patientPeek = await api('GET', `/api/appointments/${apptId}/pre-visit-summary`, {
    token: patientToken,
  });
  check('patient blocked from pre-visit summary', patientPeek.status === 403, `got ${patientPeek.status}`);

  return { adminToken, doctorToken, patientToken, apptId, doctorId, stamp };
}

main()
  .then(async (ctx) => {
    const { runPart2 } = await import('./verify-summaries2.js');
    await runPart2({ api, check, prisma, ctx, runSummaryPass });
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\nsummary verification crashed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
