import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Field, when } from '../ui.jsx';

const FREQUENCIES = [
  ['ONCE_DAILY', 'Once a day'],
  ['TWICE_DAILY', 'Twice a day'],
  ['THRICE_DAILY', 'Three times a day'],
  ['FOUR_TIMES_DAILY', 'Four times a day'],
  ['EVERY_OTHER_DAY', 'Every other day'],
  ['WEEKLY', 'Weekly'],
  ['AS_NEEDED', 'As needed'],
];

const blank = { medicationName: '', dosage: '', frequency: 'TWICE_DAILY', durationDays: 5, instructions: '' };

export default function VisitNoteForm({ appointment, onCancel, onDone }) {
  const [form, setForm] = useState({ clinicalNotes: '', diagnosis: '', advice: '', followUpDate: '' });
  const [meds, setMeds] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setMed = (i, k) => (e) =>
    setMeds(meds.map((m, j) => (j === i ? { ...m, [k]: e.target.value } : m)));

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api(`/api/appointments/${appointment.id}/visit-note`, {
        method: 'POST',
        body: {
          clinicalNotes: form.clinicalNotes,
          ...(form.diagnosis ? { diagnosis: form.diagnosis } : {}),
          ...(form.advice ? { advice: form.advice } : {}),
          ...(form.followUpDate ? { followUpDate: form.followUpDate } : {}),
          prescriptions: meds
            .filter((m) => m.medicationName && m.dosage)
            .map((m) => ({ ...m, durationDays: Number(m.durationDays) })),
        },
      });
      onDone();
    } catch (err) {
      setError(err.details?.[0]?.message ?? err.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Complete visit</h1>
      <p className="muted">{appointment.patient?.fullName} · {when(appointment.slotStart)}</p>
      <Alert>{error}</Alert>

      <div className="card">
        <form onSubmit={submit}>
          <Field label="Clinical notes *">
            <textarea value={form.clinicalNotes} onChange={set('clinicalNotes')} required minLength={10} />
          </Field>
          <p className="muted">
            Written up for the patient in plain language automatically. Write clinically.
          </p>

          <Field label="Diagnosis"><input value={form.diagnosis} onChange={set('diagnosis')} /></Field>
          <Field label="Advice"><textarea value={form.advice} onChange={set('advice')} /></Field>
          <Field label="Follow-up date">
            <input type="date" value={form.followUpDate} onChange={set('followUpDate')} />
          </Field>

          <h3 style={{ marginTop: 18 }}>Prescription</h3>
          <p className="muted">Medication reminders are scheduled automatically from the frequency.</p>

          {meds.map((m, i) => (
            <div key={i} className="card" style={{ background: '#fafafa' }}>
              <div className="row">
                <div style={{ flex: 2, minWidth: 160 }}>
                  <Field label="Medicine">
                    <input value={m.medicationName} onChange={setMed(i, 'medicationName')} />
                  </Field>
                </div>
                <div style={{ flex: 1, minWidth: 110 }}>
                  <Field label="Dose"><input value={m.dosage} onChange={setMed(i, 'dosage')} placeholder="500 mg" /></Field>
                </div>
              </div>
              <div className="row">
                <div style={{ flex: 2, minWidth: 160 }}>
                  <Field label="Frequency">
                    <select value={m.frequency} onChange={setMed(i, 'frequency')}>
                      {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </Field>
                </div>
                <div style={{ flex: 1, minWidth: 100 }}>
                  <Field label="Days">
                    <input type="number" min="1" value={m.durationDays} onChange={setMed(i, 'durationDays')} />
                  </Field>
                </div>
              </div>
              <Field label="Instructions">
                <input value={m.instructions} onChange={setMed(i, 'instructions')} placeholder="after food" />
              </Field>
              <button
                type="button"
                className="danger"
                style={{ marginTop: 8 }}
                onClick={() => setMeds(meds.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}

          <button type="button" className="ghost" onClick={() => setMeds([...meds, { ...blank }])}>
            Add medicine
          </button>

          <div className="row" style={{ marginTop: 18 }}>
            <button disabled={busy}>{busy ? 'Saving…' : 'Save and complete'}</button>
            <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </>
  );
}
