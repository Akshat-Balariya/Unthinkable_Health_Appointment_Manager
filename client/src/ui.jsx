export const Pill = ({ children }) => <span className={`pill ${children}`}>{children}</span>;

export const Alert = ({ kind = 'error', children }) =>
  children ? <div className={`alert ${kind}`}>{children}</div> : null;

export const when = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit',
  });

export const day = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function Field({ label, children }) {
  return (
    <div>
      <label>{label}</label>
      {children}
    </div>
  );
}
