/** The isolation assertions themselves. */
export async function runIsolation({ stamp, tokenA, tokenB, docA, docB, api, check }) {
  console.log('\nCross-clinic isolation');

  // --- listings are scoped --------------------------------------------------
  const listA = await api('GET', '/api/admin/doctors?limit=100', { token: tokenA });
  const idsA = (listA.body?.data ?? []).map((d) => d.id);
  check('clinic A sees only its own doctor', idsA.length === 1 && idsA[0] === docA.id,
    `saw ${idsA.length} doctors`);
  check("clinic A cannot see clinic B's doctor", !idsA.includes(docB.id));
  check("clinic A cannot see the seeded clinic's doctors",
    !(listA.body?.data ?? []).some((d) => d.specialisation === 'Cardiology'));

  // --- direct access by id --------------------------------------------------
  const peek = await api('GET', `/api/admin/doctors/${docB.id}`, { token: tokenA });
  check("reading another clinic's doctor -> 404", peek.status === 404, `got ${peek.status}`);
  check('404 rather than 403, so ids cannot be probed',
    peek.body?.error?.code === 'NOT_FOUND', peek.body?.error?.code);

  // --- mutations ------------------------------------------------------------
  const edit = await api('PATCH', `/api/admin/doctors/${docB.id}`, {
    token: tokenA, body: { consultationFee: 1 },
  });
  check("editing another clinic's doctor -> 404", edit.status === 404, `got ${edit.status}`);

  const hours = await api('PUT', `/api/admin/doctors/${docB.id}/working-hours`, {
    token: tokenA, body: { workingHours: [{ dayOfWeek: 2, startTime: '08:00', endTime: '09:00' }] },
  });
  check("rewriting another clinic's schedule -> 404", hours.status === 404, `got ${hours.status}`);

  const deact = await api('DELETE', `/api/admin/doctors/${docB.id}`, { token: tokenA });
  check("deactivating another clinic's doctor -> 404", deact.status === 404, `got ${deact.status}`);

  const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const leave = await api('POST', `/api/admin/doctors/${docB.id}/leaves`, {
    token: tokenA, body: { leaveDate: future, reason: 'hostile leave' },
  });
  check("marking leave on another clinic's doctor -> 404", leave.status === 404, `got ${leave.status}`);

  const preview = await api('POST', `/api/admin/doctors/${docB.id}/leaves/preview`, {
    token: tokenA, body: { leaveDate: future },
  });
  check('leave preview is scoped too -> 404', preview.status === 404, `got ${preview.status}`);

  // --- confirm B is genuinely untouched ------------------------------------
  const stillB = await api('GET', `/api/admin/doctors/${docB.id}`, { token: tokenB });
  check('clinic B doctor still intact', stillB.status === 200 && stillB.body.isActive === true,
    `status ${stillB.status}, active ${stillB.body?.isActive}`);
  check('fee unchanged by the hostile edit', stillB.body?.consultationFee === 0,
    `fee is ${stillB.body?.consultationFee}`);
  check('schedule unchanged', stillB.body?.workingHours?.[0]?.dayOfWeek === 1,
    JSON.stringify(stillB.body?.workingHours));

  // --- own clinic still works ----------------------------------------------
  console.log('\nOwn-clinic operations still work');

  const ownEdit = await api('PATCH', `/api/admin/doctors/${docA.id}`, {
    token: tokenA, body: { consultationFee: 750 },
  });
  check('clinic A can edit its own doctor', ownEdit.status === 200 && ownEdit.body.consultationFee === 750);

  const ownLeave = await api('POST', `/api/admin/doctors/${docA.id}/leaves`, {
    token: tokenA, body: { leaveDate: future, reason: 'Training' },
  });
  check('clinic A can mark its own doctor on leave', ownLeave.status === 201, `got ${ownLeave.status}`);

  // --- platform admin is unscoped ------------------------------------------
  console.log('\nPlatform admin');

  const admin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@clinic.test', password: 'Password123!' },
  });
  const adminToken = admin.body.tokens.accessToken;

  const allDoctors = await api('GET', '/api/admin/doctors?limit=100', { token: adminToken });
  const allIds = (allDoctors.body?.data ?? []).map((d) => d.id);
  check('platform admin sees both clinics', allIds.includes(docA.id) && allIds.includes(docB.id),
    `saw ${allIds.length} doctors`);

  const adminPeek = await api('GET', `/api/admin/doctors/${docB.id}`, { token: adminToken });
  check('platform admin can read any doctor', adminPeek.status === 200, `got ${adminPeek.status}`);

  // --- patients see across clinics ------------------------------------------
  console.log('\nPatient directory spans clinics');

  const patient = await api('POST', '/api/auth/login', {
    body: { email: 'patient.one@example.test', password: 'Password123!' },
  });
  const pToken = patient.body.tokens.accessToken;

  const clinicsList = await api('GET', '/api/clinics');
  check('public clinic list available', clinicsList.status === 200 && clinicsList.body.length >= 2,
    `${clinicsList.body?.length} clinics`);

  const search = await api('GET', '/api/doctors?specialisation=Isolation%20Testing', { token: pToken });
  const found = (search.body?.data ?? []).map((d) => d.id);
  check('patient sees doctors from both clinics', found.includes(docA.id) && found.includes(docB.id),
    `found ${found.length}`);
  check('doctor cards carry their clinic name',
    (search.body?.data ?? []).every((d) => d.clinic?.name),
    JSON.stringify(search.body?.data?.[0]?.clinic));

  const filtered = await api(`GET`, `/api/doctors?clinicId=${docA.clinicId ?? ''}`, { token: pToken });
  check('patient can filter by clinic', filtered.status === 200, `got ${filtered.status}`);

  // --- clinic profile -------------------------------------------------------
  const me = await api('GET', '/api/clinics/me', { token: tokenA });
  check('clinic can read its own profile', me.status === 200 && me.body.doctorCount === 1,
    `doctorCount ${me.body?.doctorCount}`);

  const patientPeek = await api('GET', '/api/clinics/me', { token: pToken });
  check('patient cannot read clinic profile -> 403', patientPeek.status === 403, `got ${patientPeek.status}`);
}
