import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import PatientBook from './pages/PatientBook.jsx';
import PatientAppointments from './pages/PatientAppointments.jsx';
import DoctorAppointments from './pages/DoctorAppointments.jsx';
import AdminDoctors from './pages/AdminDoctors.jsx';
import Settings from './pages/Settings.jsx';

function Nav() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const link = ({ isActive }) => (isActive ? 'active' : undefined);

  return (
    <div className="topbar">
      <span className="brand">Clinic Care</span>
      <nav>
        {user.role === 'PATIENT' && (
          <>
            <NavLink to="/book" className={link}>Book</NavLink>
            <NavLink to="/appointments" className={link}>My appointments</NavLink>
          </>
        )}
        {user.role === 'DOCTOR' && (
          <NavLink to="/schedule" className={link}>My schedule</NavLink>
        )}
        {user.role === 'ADMIN' && (
          <NavLink to="/admin/doctors" className={link}>Doctors</NavLink>
        )}
        <NavLink to="/settings" className={link}>Settings</NavLink>
        <span className="muted">{user.fullName}</span>
        <button className="ghost" onClick={async () => { await logout(); nav('/login'); }}>
          Sign out
        </button>
      </nav>
    </div>
  );
}

const homeFor = (role) =>
  role === 'DOCTOR' ? '/schedule' : role === 'ADMIN' ? '/admin/doctors' : '/book';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="wrap"><p className="muted">Loading…</p></div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <>
      <Nav />
      <div className="wrap">
        <Routes>
          <Route path="/book" element={<PatientBook />} />
          <Route path="/appointments" element={<PatientAppointments />} />
          <Route path="/schedule" element={<DoctorAppointments />} />
          <Route path="/admin/doctors" element={<AdminDoctors />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/calendar/connected" element={<Settings />} />
          <Route path="*" element={<Navigate to={homeFor(user.role)} replace />} />
        </Routes>
      </div>
    </>
  );
}
