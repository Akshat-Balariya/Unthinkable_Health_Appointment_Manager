/**
 * Proves multi-tenant isolation: a clinic admin can manage its own doctors and
 * cannot see, edit, or take leave against another clinic's.
 *
 * Requires the server running.  node scripts/verify-clinic-isolation.js
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000';
let pass = 0;
let fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ''}`); }
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
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

const doctorPayload = (stamp, tag) => ({
  email: `dr.${tag}.${stamp}@clinic.test`,
  password: 'Passw0rdTest',
  fullName: `Dr ${tag}`,
  specialisation: 'Isolation Testing',
  slotDurationMin: 30,
  workingHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
});

async function main() {
  const stamp = Date.now();
  console.log('\nClinic isolation verification\n');

  // --- registration --------------------------------------------------------
  console.log('Clinic self-registration');

  const a = await api('POST', '/api/clinics/register', {
    body: {
      name: `Alpha Clinic ${stamp}`,
      clinicEmail: `alpha.${stamp}@clinic.test`,
      adminName: 'Alpha Admin',
      adminEmail: `alpha.admin.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      city: 'Pune',
    },
  });
  check('clinic A registers -> 201', a.status === 201, JSON.stringify(a.body).slice(0, 160));
  check('returns tokens immediately', Boolean(a.body?.tokens?.accessToken));
  check('role is CLINIC_ADMIN', a.body?.user?.role === 'CLINIC_ADMIN', a.body?.user?.role);
  check('slug generated from name', Boolean(a.body?.clinic?.slug), a.body?.clinic?.slug);

  const b = await api('POST', '/api/clinics/register', {
    body: {
      name: `Beta Clinic ${stamp}`,
      clinicEmail: `beta.${stamp}@clinic.test`,
      adminName: 'Beta Admin',
      adminEmail: `beta.admin.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
    },
  });
  check('clinic B registers -> 201', b.status === 201);

  const tokenA = a.body.tokens.accessToken;
  const tokenB = b.body.tokens.accessToken;

  const dupe = await api('POST', '/api/clinics/register', {
    body: {
      name: 'Duplicate Clinic', clinicEmail: `alpha.${stamp}@clinic.test`,
      adminName: 'Duplicate Admin', adminEmail: `x.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
    },
  });
  check('duplicate clinic email -> 409', dupe.status === 409, `got ${dupe.status}`);

  // A clinic cannot promote itself by sending a role.
  const escalate = await api('POST', '/api/clinics/register', {
    body: {
      name: `Sneaky Clinic ${stamp}`, clinicEmail: `sneaky.${stamp}@clinic.test`,
      adminName: 'Sneaky Admin', adminEmail: `sneaky.admin.${stamp}@clinic.test`,
      password: 'Passw0rdTest', role: 'ADMIN',
    },
  });
  check('role in the body cannot escalate', escalate.body?.user?.role === 'CLINIC_ADMIN',
    escalate.body?.user?.role);

  // --- each clinic adds a doctor -------------------------------------------
  console.log('\nDoctor management');

  const docA = await api('POST', '/api/admin/doctors', { token: tokenA, body: doctorPayload(stamp, 'alpha') });
  const docB = await api('POST', '/api/admin/doctors', { token: tokenB, body: doctorPayload(stamp, 'beta') });
  check('clinic A adds a doctor -> 201', docA.status === 201, JSON.stringify(docA.body).slice(0, 160));
  check('clinic B adds a doctor -> 201', docB.status === 201);

  return { stamp, tokenA, tokenB, docA: docA.body, docB: docB.body, api, check };
}

main()
  .then(async (ctx) => {
    const { runIsolation } = await import('./verify-clinic-isolation2.js');
    await runIsolation({ ...ctx, api, check });
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => { console.error('\ncrashed:', e); process.exit(1); });
