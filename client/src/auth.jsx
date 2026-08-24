import { createContext, useContext, useEffect, useState } from 'react';
import { api, tokens } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tokens.access) { setLoading(false); return; }
    api('/api/auth/me')
      .then(setUser)
      .catch(() => tokens.clear())
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    tokens.set(res.tokens);
    setUser(await api('/api/auth/me'));
  };

  const register = async (payload) => {
    const res = await api('/api/auth/register', { method: 'POST', body: payload });
    tokens.set(res.tokens);
    setUser(await api('/api/auth/me'));
  };

  const logout = async () => {
    try {
      if (tokens.refresh) {
        await api('/api/auth/logout', { method: 'POST', body: { refreshToken: tokens.refresh } });
      }
    } catch { /* logging out locally matters more than the server call */ }
    tokens.clear();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
