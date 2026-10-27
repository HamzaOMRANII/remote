// Thin fetch wrapper for the auth surface. Realtime device traffic goes over
// the WebSocket (ws.js), not here.
import { go } from './router.js';

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.endsWith('/login') && !url.endsWith('/me')) {
    go('/login')();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  login: (password) => req('POST', '/api/login', { password }),
  logout: () => req('POST', '/api/logout'),
  me: () => req('GET', '/api/me'),
};
