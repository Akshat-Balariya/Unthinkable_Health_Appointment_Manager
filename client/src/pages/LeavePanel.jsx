import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Field } from '../ui.jsx';

/**
 * Leave is previewed before it is applied. Marking a doctor unavailable can
 * cancel a whole day of bookings, so the admin sees exactly who is affected
 * before committing.
 */
export default function LeavePanel({ doctor, onDone }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');

  const check = async () => {
    setError(''); setPreview(null);
    try {
      setPreview(await api(`/api/admin/doctors/${doctor.id}/leaves/preview`, {
        method: 'POST', body: { leaveDate: date, reason: reason || undefined },
      }));
    } catch (e) { setError(e.message); }
  };

  const apply = async () => {
    setError('');
    try {
      const r = await api(`/api/admin/doctors/${doctor.id}/leaves`, {
        method: 'POST', body: { leaveDate: date, reason: reason || undefined },
      });
      onDone(`Leave recorded. ${r.affected.length} appointment(s) cancelled, patients notified.`);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="card" style={{ background: '#fafafa' }}>
      <h3>Mark leave — {doctor.fullName}</h3>
      <Alert>{error}</Alert>
      <div className="row">
        <div style={{ flex: 1, minWidth: 160 }}>
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div style={{ flex: 2, minWidth: 180 }}>
          <Field label="Reason">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="ghost" disabled={!date} onClick={check}>Check impact</button>
        {preview && (
          <button className="danger" onClick={apply}>
            Confirm — cancel {preview.affectedCount} appointment(s)
          </button>
        )}
      </div>

      {preview && (
        <div style={{ marginTop: 10 }}>
          {preview.affectedCount === 0 ? (
            <p className="muted">No appointments are affected on this date.</p>
          ) : (
            <>
              <p className="muted">These patients will be cancelled and emailed:</p>
              <ul className="tight">
                {preview.affected.map((a) => (
                  <li key={a.appointmentId}>
                    {new Date(a.slotStart).toLocaleString()} — {a.patientName}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
