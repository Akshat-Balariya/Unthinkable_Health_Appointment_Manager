const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const store = {
  get access() { return localStorage.getItem('accessToken'); },
  get refresh() { return localStorage.getItem('refreshToken'); },
  set({ accessToken, refreshToken }) {
    localStorage.setItem('accessToken', accessToken);
    if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
  },
  clear() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

let refreshing = null;

/**
 * Transparently refreshes the access token on a 401 and replays the request
 * once. Concurrent 401s share a single refresh, otherwise each would rotate the
 * token and invalidate the others - the server treats a replayed refresh token
 * as theft and kills every session.
 */
async function refreshTokens() {
  if (!store.refresh) throw new ApiError(401, {});
  refreshing ??= fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: store.refresh }),
  })
    .then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => null));
      const data = await r.json();
      store.set(data.tokens);
      return data;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(store.access ? { Authorization: `Bearer ${store.access}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 && retry && store.refresh) {
    try {
      await refreshTokens();
      return api(path, { method, body, retry: false });
    } catch {
      store.clear();
    }
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const tokens = store;
