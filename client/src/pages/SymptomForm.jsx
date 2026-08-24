import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Field, when } from '../ui.jsx';

/**
 * Step 2 of booking. The slot is already HELD, so the countdown is real: when it
 * lapses the server rejects the confirm and the slot returns to the pool.
 */
export default function SymptomForm({ appointment, doctor, onCancel, onDone }) {
  const nav = useNavigate();
  const [form, setForm] = useState({
    symptomsText: '', durationDays: '', severity: '',
    existingConditions: '', currentMedications: '',
  });
  const [left, setLeft] = useState(appointment.holdExpiresInSeconds ?? 600);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api(`/api/appointments/${appointment.id}/confirm`, {
        method: 'POST',
        body: {
          symptomsText: form.symptomsText,
          ...(form.durationDays ? { durationDays: Number(form.durationDays) } : {}),
          ...(form.severity ? { severity: Number(form.severity) } : {}),
          ...(form.existingConditions ? { existingConditions: form.existingConditions } : {}),
          ...(form.currentMedications ? { currentMedications: form.currentMedications } : {}),
        },
      });
      onDone();
      nav('/appointments');
    } catch (err) {
      setError(err.details?.[0]?.message ?? err.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Describe your symptoms</h1>
      <p className="muted">
        {doctor.fullName} · {when(appointment.slotStart)}
      </p>

      {left > 0 ? (
        <div className="alert ok">
          This slot is held for you — <strong>{mmss}</strong> remaining.
        </div>
      ) : (
        <div className="alert error">
          Your hold has expired. Please choose a time again.
        </div>
      )}

      <Alert>{error}</Alert>

      <div className="card">
        <form onSubmit={submit}>
          <Field label="What is troubling you? *">
            <textarea
              value={form.symptomsText}
              onChange={set('symptomsText')}
              placeholder="Describe your symptoms, when they started, and how they have changed."
              required
              minLength={10}
            />
          </Field>
          <p className="muted">
            Shared with your doctor before the visit, along with an AI-generated summary.
          </p>

          <div className="row">
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="How many days?">
                <input type="number" min="0" value={form.durationDays} onChange={set('durationDays')} />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="Severity (1–10)">
                <input type="number" min="1" max="10" value={form.severity} onChange={set('severity')} />
              </Field>
            </div>
          </div>

          <Field label="Existing conditions">
            <input value={form.existingConditions} onChange={set('existingConditions')} />
          </Field>
          <Field label="Current medications">
            <input value={form.currentMedications} onChange={set('currentMedications')} />
          </Field>

          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy || left === 0}>
              {busy ? 'Confirming…' : 'Confirm appointment'}
            </button>
            <button type="button" className="ghost" onClick={onCancel}>
              Release slot
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
