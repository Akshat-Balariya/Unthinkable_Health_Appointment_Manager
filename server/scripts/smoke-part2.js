/**
 * End-to-end smoke test for Part 2 (auth + admin doctor management).
 * Requires the server to be running.  Usage: node scripts/smoke-part2.js
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

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
  console.log(`\nSmoke test against ${BASE}\n`);

  // -- auth ----------------------------------------------------------------
  console.log('Auth');

  const reg = await api('POST', '/api/auth/register', {
    body: {
      email: `smoke.patient.${stamp}@example.test`,
      password: 'Passw0rdTest',
      fullName: 'Smoke Patient',
      gender: 'Other',
    },
  });
  check('register patient -> 201', reg.status === 201, `got ${reg.status}`);
  check('register returns tokens', Boolean(reg.body?.tokens?.accessToken));
  check('register does not leak passwordHash', !JSON.stringify(reg.body).includes('passwordHash'));
  const patientToken = reg.body?.tokens?.accessToken;

  const weak = await api('POST', '/api/auth/register', {
    body: { email: `w.${stamp}@example.test`, password: 'short', fullName: 'X Y' },
  });
  check('weak password -> 400', weak.status === 400, `got ${weak.status}`);
  check('validation lists the failing field', Array.isArray(weak.body?.error?.details));

  const dupe = await api('POST', '/api/auth/register', {
    body: {
      email: `smoke.patient.${stamp}@example.test`,
      password: 'Passw0rdTest',
      fullName: 'Dup',
    },
  });
  check('duplicate email -> 409', dupe.status === 409, `got ${dupe.status}`);

  const badLogin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@clinic.test', password: 'wrong-password' },
  });
  check('bad password -> 401', badLogin.status === 401, `got ${badLogin.status}`);

  const adminLogin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@clinic.test', password: 'Password123!' },
  });
  check('admin login -> 200', adminLogin.status === 200, `got ${adminLogin.status}`);
  const adminToken = adminLogin.body?.tokens?.accessToken;
  const adminRefresh = adminLogin.body?.tokens?.refreshToken;

  const me = await api('GET', '/api/auth/me', { token: adminToken });
  check('GET /me -> role ADMIN', me.body?.role === 'ADMIN', JSON.stringify(me.body));

  const noToken = await api('GET', '/api/auth/me');
  check('no token -> 401', noToken.status === 401, `got ${noToken.status}`);

  const badToken = await api('GET', '/api/auth/me', { token: 'not-a-jwt' });
  check('garbage token -> 401', badToken.status === 401, `got ${badToken.status}`);

  // -- refresh rotation ----------------------------------------------------
  console.log('\nRefresh rotation');

  const r1 = await api('POST', '/api/auth/refresh', { body: { refreshToken: adminRefresh } });
  check('refresh -> 200 with new pair', r1.status === 200 && Boolean(r1.body?.tokens?.refreshToken));
  check('rotated token differs', r1.body?.tokens?.refreshToken !== adminRefresh);

  const replay = await api('POST', '/api/auth/refresh', { body: { refreshToken: adminRefresh } });
  check('replaying old refresh -> 401', replay.status === 401, `got ${replay.status}`);

  const afterReplay = await api('POST', '/api/auth/refresh', {
    body: { refreshToken: r1.body?.tokens?.refreshToken },
  });
  check(
    'replay revoked the whole family -> 401',
    afterReplay.status === 401,
    `got ${afterReplay.status}`
  );

  return { adminToken, patientToken, stamp };
}

main()
  .then(async ({ adminToken, patientToken, stamp }) => {
    const { runAdminChecks } = await import('./smoke-part2-admin.js');
    await runAdminChecks({ api, check, adminToken, patientToken, stamp });
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\nsmoke test crashed:', e.message);
    process.exit(1);
  });
