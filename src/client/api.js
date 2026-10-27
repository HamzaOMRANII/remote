// Thin fetch wrapper for the auth + user-management surface. Realtime device
// traffic goes over the WebSocket (ws.js), not here.
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
  login: (username, password) => req('POST', '/api/login', { username, password }),
  logout: () => req('POST', '/api/logout'),
  me: () => req('GET', '/api/me'),

  // user CRUD (admin only)
  listUsers: () => req('GET', '/api/users'),
  createUser: (u) => req('POST', '/api/users', u),
  updateUser: (id, patch) => req('PUT', `/api/users/${encodeURIComponent(id)}`, patch),
  deleteUser: (id) => req('DELETE', `/api/users/${encodeURIComponent(id)}`),

  // device provisioning (list: any signed-in user; mutations: admin only)
  listDevices: () => req('GET', '/api/devices'),
  createDevice: (d) => req('POST', '/api/devices', d),
  updateDevice: (id, patch) => req('PUT', `/api/devices/${encodeURIComponent(id)}`, patch),
  rotateDevice: (id) => req('POST', `/api/devices/${encodeURIComponent(id)}/rotate`),
  deleteDevice: (id) => req('DELETE', `/api/devices/${encodeURIComponent(id)}`),
};
