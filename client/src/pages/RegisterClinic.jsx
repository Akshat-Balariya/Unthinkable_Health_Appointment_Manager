import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, tokens } from '../api.js';
import { Alert, Field } from '../ui.jsx';

const blank = {
  name: '', clinicEmail: '', phone: '', addressLine: '', city: '',
  adminName: '', adminEmail: '', password: '',
};

export default function RegisterClinic() {
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const res = await api('/api/clinics/register', { method: 'POST', body: form });
      tokens.set(res.tokens);
      // Full reload so the auth context picks up the new CLINIC_ADMIN session.
      window.location.href = '/clinic/doctors';
    } catch (err) {
      setError(err.details?.[0] ? `${err.details[0].field}: ${err.details[0].message}` : err.message);
      setBusy(false);
    }
  };

  return (
    <div className="wrap" style={{ maxWidth: 620, margin: '6vh auto' }}>
      <div className="card">
        <h1>Register your clinic</h1>
        <p className="muted">
          Create a clinic account, then add your doctors and manage their schedules.
        </p>
        <Alert>{error}</Alert>

        <form onSubmit={submit}>
          <h2 style={{ marginTop: 16 }}>Clinic</h2>
          <Field label="Clinic name"><input value={form.name} onChange={set('name')} required /></Field>
          <div className="row">
            <div style={{ flex: 1, minWidth: 200 }}>
              <Field label="Clinic email">
                <input type="email" value={form.clinicEmail} onChange={set('clinicEmail')} required />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <Field label="Phone"><input value={form.phone} onChange={set('phone')} /></Field>
            </div>
          </div>
          <div className="row">
            <div style={{ flex: 2, minWidth: 200 }}>
              <Field label="Address"><input value={form.addressLine} onChange={set('addressLine')} /></Field>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <Field label="City"><input value={form.city} onChange={set('city')} /></Field>
            </div>
          </div>

          <h2 style={{ marginTop: 20 }}>Administrator account</h2>
          <p className="muted">This is the login you will use to manage the clinic.</p>
          <Field label="Your name"><input value={form.adminName} onChange={set('adminName')} required /></Field>
          <div className="row">
            <div style={{ flex: 1, minWidth: 200 }}>
              <Field label="Your email">
                <input type="email" value={form.adminEmail} onChange={set('adminEmail')} required />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="Password">
                <input type="password" value={form.password} onChange={set('password')} required />
              </Field>
            </div>
          </div>
          <p className="muted">At least 8 characters, with upper, lower and a digit.</p>

          <div style={{ marginTop: 18 }}>
            <button disabled={busy}>{busy ? 'Creating…' : 'Register clinic'}</button>
          </div>
        </form>

        <p className="muted" style={{ marginTop: 14 }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
