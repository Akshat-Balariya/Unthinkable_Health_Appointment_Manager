import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert } from '../ui.jsx';

export default function Settings() {
  const { user } = useAuth();
  const [cal, setCal] = useState(null);
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const status = params.get('status');

  const load = () => api('/api/calendar/status').then(setCal).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const connect = async () => {
    try {
      const { authUrl } = await api('/api/calendar/google/connect');
      window.location.href = authUrl;
    } catch (e) { setError(e.message); }
  };

  const disconnect = async () => {
    try {
      await api('/api/calendar/google', { method: 'DELETE' });
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <>
      <h1>Settings</h1>
      <Alert>{error}</Alert>
      {status === 'connected' && <Alert kind="ok">Google Calendar connected.</Alert>}
      {status === 'denied' && <Alert>Calendar access was declined.</Alert>}
      {status === 'failed' && <Alert>Could not connect to Google Calendar.</Alert>}

      <div className="card">
        <h2>Account</h2>
        <p className="muted">{user.fullName} · {user.email} · {user.role}</p>
      </div>

      <div className="card">
        <h2>Google Calendar</h2>
        {!cal && <p className="muted">Checking…</p>}
        {cal && !cal.enabled && (
          <p className="muted">Calendar sync is not configured on this server.</p>
        )}
        {cal?.enabled && (cal.connected ? (
          <>
            <p className="muted">
              Connected. Appointments are added to your calendar and removed when cancelled.
            </p>
            <button className="danger" onClick={disconnect}>Disconnect</button>
          </>
        ) : (
          <>
            <p className="muted">
              Connect so appointments appear in your Google Calendar automatically.
            </p>
            <button onClick={connect}>Connect Google Calendar</button>
          </>
        ))}
      </div>
    </>
  );
}
