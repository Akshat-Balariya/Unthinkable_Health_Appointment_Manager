import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Alert, Field } from '../ui.jsx';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap auth">
      <div className="card">
        <h1>Sign in</h1>
        <p className="muted">Patient, doctor or admin.</p>
        <Alert>{error}</Alert>
        <form onSubmit={submit}>
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <div style={{ marginTop: 16 }}>
            <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </div>
        </form>
        <p className="muted" style={{ marginTop: 14 }}>
          New patient? <Link to="/register">Create an account</Link>
          <br />
          Running a clinic? <Link to="/register-clinic">Register your clinic</Link>
        </p>
      </div>
    </div>
  );
}
