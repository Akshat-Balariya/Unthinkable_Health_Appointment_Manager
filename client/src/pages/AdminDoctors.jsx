import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Field } from '../ui.jsx';
import LeavePanel from './LeavePanel.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const blank = {
  fullName: '', email: '', password: '', specialisation: '',
  qualifications: '', consultationFee: 500, slotDurationMin: 30,
};

export default function AdminDoctors() {
  const [doctors, setDoctors] = useState([]);
  const [form, setForm] = useState(blank);
  const [creating, setCreating] = useState(false);
  const [leaveFor, setLeaveFor] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const load = () =>
    api('/api/admin/doctors?limit=50')
      .then((r) => setDoctors(r.data))
      .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const create = async (e) => {
    e.preventDefault();
    setError(''); setOk('');
    try {
      await api('/api/admin/doctors', {
        method: 'POST',
        body: {
          ...form,
          consultationFee: Number(form.consultationFee),
          slotDurationMin: Number(form.slotDurationMin),
          workingHours: [1, 2, 3, 4, 5].flatMap((dayOfWeek) => [
            { dayOfWeek, startTime: '09:00', endTime: '13:00' },
            { dayOfWeek, startTime: '16:00', endTime: '19:00' },
          ]),
        },
      });
      setForm(blank); setCreating(false); setOk('Doctor created.'); load();
    } catch (err) {
      setError(err.details?.[0]?.message ?? err.message);
    }
  };

  return (
    <>
      <h1>Doctors</h1>
      <Alert>{error}</Alert>
      <Alert kind="ok">{ok}</Alert>

      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'Add doctor'}</button>
      </div>

      {creating && <NewDoctorForm form={form} set={set} onSubmit={create} />}

      {doctors.map((d) => (
        <div key={d.id} className="card">
          <div className="row">
            <strong>{d.fullName}</strong>
            <span className="muted">{d.specialisation}</span>
            {!d.isActive && <span className="pill CANCELLED">inactive</span>}
            <span className="right muted">{d.slotDurationMin} min · ₹{d.consultationFee}</span>
          </div>
          <div className="muted">
            {d.email} · {d.workingHours.length} weekly blocks
            {d.workingHours.length > 0 &&
              ` (${[...new Set(d.workingHours.map((w) => DAYS[w.dayOfWeek]))].join(', ')})`}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => setLeaveFor(leaveFor === d.id ? null : d.id)}>
              {leaveFor === d.id ? 'Close' : 'Mark leave'}
            </button>
          </div>
          {leaveFor === d.id && (
            <LeavePanel doctor={d} onDone={(msg) => { setOk(msg); setLeaveFor(null); }} />
          )}
        </div>
      ))}
    </>
  );
}

function NewDoctorForm({ form, set, onSubmit }) {
  return (
    <div className="card">
      <h2>New doctor</h2>
      <form onSubmit={onSubmit}>
        <div className="row">
          <div style={{ flex: 1, minWidth: 180 }}>
            <Field label="Full name"><input value={form.fullName} onChange={set('fullName')} required /></Field>
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Field label="Specialisation"><input value={form.specialisation} onChange={set('specialisation')} required /></Field>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1, minWidth: 180 }}>
            <Field label="Email"><input type="email" value={form.email} onChange={set('email')} required /></Field>
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Field label="Temporary password"><input value={form.password} onChange={set('password')} required /></Field>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 2, minWidth: 140 }}>
            <Field label="Qualifications"><input value={form.qualifications} onChange={set('qualifications')} /></Field>
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <Field label="Fee"><input type="number" value={form.consultationFee} onChange={set('consultationFee')} /></Field>
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <Field label="Slot (min)"><input type="number" value={form.slotDurationMin} onChange={set('slotDurationMin')} /></Field>
          </div>
        </div>
        <p className="muted">Default hours: Mon-Fri, 09:00-13:00 and 16:00-19:00.</p>
        <button style={{ marginTop: 10 }}>Create doctor</button>
      </form>
    </div>
  );
}
