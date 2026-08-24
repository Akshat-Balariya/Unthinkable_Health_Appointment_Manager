import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Field, day } from '../ui.jsx';
import SymptomForm from './SymptomForm.jsx';

const localTime = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function PatientBook() {
  const [specs, setSpecs] = useState([]);
  const [spec, setSpec] = useState('');
  const [doctors, setDoctors] = useState([]);
  const [selected, setSelected] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [held, setHeld] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/doctors/specialisations').then(setSpecs).catch(() => {}); }, []);

  useEffect(() => {
    const q = spec ? `?specialisation=${encodeURIComponent(spec)}` : '';
    api(`/api/doctors${q}`).then((r) => setDoctors(r.data)).catch((e) => setError(e.message));
    setSelected(null); setAvailability(null);
  }, [spec]);

  const openDoctor = async (doctor) => {
    setSelected(doctor); setAvailability(null); setError('');
    try {
      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 13 * 864e5).toISOString().slice(0, 10);
      setAvailability(await api(`/api/doctors/${doctor.id}/availability?from=${from}&to=${to}`));
    } catch (e) { setError(e.message); }
  };

  const hold = async (slotStart) => {
    setError(''); setBusy(true);
    try {
      setHeld(await api('/api/appointments/hold', {
        method: 'POST',
        body: { doctorId: selected.id, slotStart },
      }));
    } catch (e) {
      setError(e.message);
      // Somebody took it first - refresh so the grid reflects reality.
      if (e.code === 'SLOT_UNAVAILABLE') openDoctor(selected);
    } finally { setBusy(false); }
  };

  if (held) {
    return (
      <SymptomForm
        appointment={held}
        doctor={selected}
        onCancel={async () => {
          try { await api(`/api/appointments/${held.id}/hold`, { method: 'DELETE' }); } catch {}
          setHeld(null); openDoctor(selected);
        }}
        onDone={() => { setHeld(null); setSelected(null); }}
      />
    );
  }

  return (
    <>
      <h1>Book an appointment</h1>
      <p className="muted">Choose a specialisation, then a doctor and a time.</p>
      <Alert>{error}</Alert>

      <div className="card">
        <Field label="Specialisation">
          <select value={spec} onChange={(e) => setSpec(e.target.value)}>
            <option value="">All specialisations</option>
            {specs.map((s) => (
              <option key={s.specialisation} value={s.specialisation}>
                {s.specialisation} ({s.doctorCount})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid">
        {doctors.map((d) => (
          <div key={d.id} className="card">
            <h3>{d.fullName}</h3>
            <div className="muted">{d.specialisation}</div>
            <div className="muted">{d.qualifications}</div>
            <div className="muted" style={{ marginTop: 6 }}>
              {d.slotDurationMin} min · ₹{d.consultationFee}
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="ghost" onClick={() => openDoctor(d)}>
                {selected?.id === d.id ? 'Viewing' : 'See times'}
              </button>
            </div>
          </div>
        ))}
        {doctors.length === 0 && <p className="muted">No doctors found.</p>}
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Available times — {selected.fullName}</h2>
          {!availability && <p className="muted">Loading…</p>}
          {availability?.days.map((d) => (
            <div key={d.date} style={{ marginBottom: 12 }}>
              <strong>{day(`${d.date}T12:00:00Z`)}</strong>{' '}
              {d.onLeave && <span className="pill CANCELLED">on leave</span>}
              <div className="row" style={{ marginTop: 6 }}>
                {d.slots.map((s) => (
                  <button
                    key={s.start}
                    className="ghost slot"
                    disabled={busy}
                    onClick={() => hold(s.start)}
                  >
                    {localTime(s.start)}
                  </button>
                ))}
                {!d.onLeave && d.slots.length === 0 && (
                  <span className="muted">No times available</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
