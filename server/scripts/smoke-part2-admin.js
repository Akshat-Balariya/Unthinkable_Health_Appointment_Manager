/** Admin + directory half of the Part 2 smoke test. Imported by smoke-part2.js. */

export async function runAdminChecks({ api, check, adminToken, patientToken, stamp }) {
  console.log('\nRBAC');

  const forbidden = await api('POST', '/api/admin/doctors', {
    token: patientToken,
    body: {
      email: `x.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Nope',
      specialisation: 'Cardiology',
    },
  });
  check('patient creating a doctor -> 403', forbidden.status === 403, `got ${forbidden.status}`);

  const adminList = await api('GET', '/api/admin/doctors', { token: patientToken });
  check('patient listing admin doctors -> 403', adminList.status === 403);

  console.log('\nAdmin: doctor management');

  const created = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.smoke.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Smoke Test',
      specialisation: 'Neurology',
      qualifications: 'MBBS, DM',
      consultationFee: 1200,
      slotDurationMin: 20,
      bufferMin: 5,
      workingHours: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '12:00' },
      ],
    },
  });
  check('create doctor -> 201', created.status === 201, JSON.stringify(created.body).slice(0, 200));
  check('slot config persisted', created.body?.slotDurationMin === 20 && created.body?.bufferMin === 5);
  check('working hours persisted', created.body?.workingHours?.length === 3);
  const doctorId = created.body?.id;

  const overlapping = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.overlap.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Overlap',
      specialisation: 'Neurology',
      workingHours: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '11:00', endTime: '15:00' },
      ],
    },
  });
  check('overlapping working hours -> 400', overlapping.status === 400, `got ${overlapping.status}`);

  const badTime = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      email: `dr.bad.${stamp}@clinic.test`,
      password: 'Passw0rdTest',
      fullName: 'Dr Bad',
      specialisation: 'Neurology',
      workingHours: [{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }],
    },
  });
  check('endTime before startTime -> 400', badTime.status === 400, `got ${badTime.status}`);

  const patched = await api('PATCH', `/api/admin/doctors/${doctorId}`, {
    token: adminToken,
    body: { consultationFee: 1500, slotDurationMin: 30 },
  });
  check('patch doctor -> 200', patched.status === 200);
  check(
    'patch applied',
    patched.body?.consultationFee === 1500 && patched.body?.slotDurationMin === 30
  );

  const replaced = await api('PUT', `/api/admin/doctors/${doctorId}/working-hours`, {
    token: adminToken,
    body: { workingHours: [{ dayOfWeek: 2, startTime: '10:00', endTime: '13:00' }] },
  });
  check('replace working hours -> 200', replaced.status === 200);
  check('schedule fully replaced', replaced.body?.workingHours?.length === 1);

  const filtered = await api('GET', '/api/admin/doctors?specialisation=Neurology&limit=5', {
    token: adminToken,
  });
  check('filter by specialisation -> 200', filtered.status === 200);
  check('pagination present', typeof filtered.body?.pagination?.total === 'number');

  const missing = await api('GET', '/api/admin/doctors/11111111-1111-1111-1111-111111111111', {
    token: adminToken,
  });
  check('unknown doctor -> 404', missing.status === 404, `got ${missing.status}`);

  const badUuid = await api('GET', '/api/admin/doctors/not-a-uuid', { token: adminToken });
  check('malformed uuid -> 400', badUuid.status === 400, `got ${badUuid.status}`);

  await runLeaveAndDirectoryChecks({ api, check, adminToken, patientToken, doctorId });
}

async function runLeaveAndDirectoryChecks({ api, check, adminToken, patientToken, doctorId }) {
  console.log('\nAdmin: leave management');

  const future = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);

  const preview = await api('POST', `/api/admin/doctors/${doctorId}/leaves/preview`, {
    token: adminToken,
    body: { leaveDate: future, reason: 'Conference' },
  });
  check('leave preview -> 200', preview.status === 200, `got ${preview.status}`);
  check('preview reports zero conflicts', preview.body?.affectedCount === 0);
  check('preview returns the computed UTC range', preview.body?.range?.start !== undefined);

  const leave = await api('POST', `/api/admin/doctors/${doctorId}/leaves`, {
    token: adminToken,
    body: { leaveDate: future, reason: 'Conference' },
  });
  check('create leave -> 201', leave.status === 201, `got ${leave.status}`);
  check('cascade reports affected list', Array.isArray(leave.body?.affected));

  const dupLeave = await api('POST', `/api/admin/doctors/${doctorId}/leaves`, {
    token: adminToken,
    body: { leaveDate: future, reason: 'Conference again' },
  });
  check('duplicate leave -> 409', dupLeave.status === 409, `got ${dupLeave.status}`);

  const halfDay = await api('POST', `/api/admin/doctors/${doctorId}/leaves`, {
    token: adminToken,
    body: { leaveDate: future, startTime: '14:00' },
  });
  check('partial leave missing endTime -> 400', halfDay.status === 400, `got ${halfDay.status}`);

  const leaves = await api('GET', `/api/admin/doctors/${doctorId}/leaves`, { token: adminToken });
  check('list leaves -> 200', leaves.status === 200 && leaves.body?.length >= 1);

  const delLeave = await api(
    'DELETE',
    `/api/admin/doctors/${doctorId}/leaves/${leave.body?.leave?.id}`,
    { token: adminToken }
  );
  check('delete leave -> 200', delLeave.status === 200, `got ${delLeave.status}`);

  console.log('\nPatient: doctor directory');

  const specs = await api('GET', '/api/doctors/specialisations', { token: patientToken });
  check('list specialisations -> 200', specs.status === 200 && Array.isArray(specs.body));

  const search = await api('GET', '/api/doctors?specialisation=Cardiology', {
    token: patientToken,
  });
  check('search by specialisation -> 200', search.status === 200);
  check('finds seeded cardiologist', search.body?.data?.length >= 1);

  const pubDoctor = await api('GET', `/api/doctors/${doctorId}`, { token: patientToken });
  check('public doctor detail -> 200', pubDoctor.status === 200);
  check('does not expose licenseNumber', !('licenseNumber' in (pubDoctor.body ?? {})));
  check('does not expose doctor email', !('email' in (pubDoctor.body ?? {})));
  check('exposes upcoming leaves', Array.isArray(pubDoctor.body?.upcomingLeaves));

  console.log('\nAdmin: deactivation');

  const deact = await api('DELETE', `/api/admin/doctors/${doctorId}`, { token: adminToken });
  check('deactivate doctor -> 200', deact.status === 200 && deact.body?.isActive === false);

  const gone = await api('GET', `/api/doctors/${doctorId}`, { token: patientToken });
  check('deactivated doctor hidden from patients -> 404', gone.status === 404, `got ${gone.status}`);
}
