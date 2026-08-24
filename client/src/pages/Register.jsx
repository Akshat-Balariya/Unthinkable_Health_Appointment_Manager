import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Alert, Field } from '../ui.jsx';

export default function Register() {
  const { register } = useAuth();
  const [form, setForm] = useState({ fullName: '', email: '', password: '', phone: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await register(form);
    } catch (err) {
      // Surface the first field-level message when validation failed.
      setError(err.details?.[0] ? `${err.details[0].field}: ${err.details[0].message}` : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap auth">
      <div className="card">
        <h1>Create account</h1>
        <p className="muted">Patient registration. Doctors are added by the clinic.</p>
        <Alert>{error}</Alert>
        <form onSubmit={submit}>
          <Field label="Full name"><input value={form.fullName} onChange={set('fullName')} required /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={set('email')} required /></Field>
          <Field label="Password">
            <input type="password" value={form.password} onChange={set('password')} required />
          </Field>
          <p className="muted">At least 8 characters, with upper, lower and a digit.</p>
          <Field label="Phone (optional)"><input value={form.phone} onChange={set('phone')} /></Field>
          <div style={{ marginTop: 16 }}>
            <button disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          </div>
        </form>
        <p className="muted" style={{ marginTop: 14 }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
