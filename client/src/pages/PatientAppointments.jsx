import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Pill, when } from '../ui.jsx';

function Summary({ appointmentId }) {
  const [s, setS] = useState(undefined); // undefined = loading, null = none

  useEffect(() => {
    api(`/api/appointments/${appointmentId}/post-visit-summary`)
      .then(setS)
      .catch(() => setS(null));
  }, [appointmentId]);

  if (s === undefined) return <p className="muted">Loading summary…</p>;
  if (!s) return null;

  // The summary is generated in the background, so "not ready" is a normal
  // state, not an error.
  if (s.status !== 'READY') {
    return (
      <p className="muted">
        {s.status === 'FAILED'
          ? 'A written summary could not be generated. Your doctor’s notes still apply.'
          : 'Your visit summary is being prepared…'}
      </p>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <h3>Your visit summary</h3>
      <p>{s.patientFriendlyText}</p>

      {s.medicationSchedule?.length > 0 && (
        <>
          <h3>Medication</h3>
          <table>
            <thead>
              <tr><th>Medicine</th><th>Dose</th><th>When</th><th>Days</th></tr>
            </thead>
            <tbody>
              {s.medicationSchedule.map((m, i) => (
                <tr key={i}>
                  <td>{m.medication}</td>
                  <td>{m.dosage}</td>
                  <td>{(m.whenToTake ?? []).join(', ')}</td>
                  <td>{m.durationDays ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {s.followUpSteps?.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Next steps</h3>
          <ul className="tight">{s.followUpSteps.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </>
      )}

      {s.warningSigns?.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Seek help sooner if you notice</h3>
          <ul className="tight">{s.warningSigns.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </>
      )}
    </div>
  );
}

export default function PatientAppointments() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = () =>
    api('/api/appointments?limit=50')
      .then((r) => setItems(r.data))
      .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const cancel = async (id) => {
    if (!confirm('Cancel this appointment?')) return;
    try {
      await api(`/api/appointments/${id}/cancel`, { method: 'POST', body: { reason: 'Cancelled by patient' } });
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <>
      <h1>My appointments</h1>
      <Alert>{error}</Alert>
      {items.length === 0 && <p className="muted">Nothing booked yet.</p>}

      {items.map((a) => (
        <div key={a.id} className="card">
          <div className="row">
            <strong>{a.doctor?.fullName}</strong>
            <Pill>{a.status}</Pill>
            <span className="right muted">{when(a.slotStart)}</span>
          </div>
          <div className="muted">{a.doctor?.specialisation}</div>
          {a.cancelReason && <div className="muted">Reason: {a.cancelReason}</div>}

          <div className="row" style={{ marginTop: 10 }}>
            {['HELD', 'CONFIRMED'].includes(a.status) && (
              <button className="danger" onClick={() => cancel(a.id)}>Cancel</button>
            )}
            {a.status === 'COMPLETED' && (
              <button className="ghost" onClick={() => setOpen(open === a.id ? null : a.id)}>
                {open === a.id ? 'Hide summary' : 'View summary'}
              </button>
            )}
          </div>

          {open === a.id && <Summary appointmentId={a.id} />}
        </div>
      ))}
    </>
  );
}
