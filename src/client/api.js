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
  // 401 = session gone -> back to login; except where 401 means "wrong password/code"
  const own401 = ['/api/login', '/api/login/code', '/api/me', '/api/verify-password', '/api/pair/claim'].includes(url)
    || url.startsWith('/api/account/');
  if (res.status === 401 && !own401) {
    go('/login')();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  login: (username, password) => req('POST', '/api/login', { username, password }),
  loginCode: (ticket, code) => req('POST', '/api/login/code', { ticket, code }),
  logout: () => req('POST', '/api/logout'),
  me: () => req('GET', '/api/me'),
  verifyPassword: (password, code) => req('POST', '/api/verify-password', { password, code }),

  // my account
  account: () => req('GET', '/api/account'),
  changePassword: (current, next) => req('POST', '/api/account/password', { current, next }),
  twoFactorSetup: (password) => req('POST', '/api/account/2fa/setup', { password }),
  twoFactorEnable: (code) => req('POST', '/api/account/2fa/enable', { code }),
  twoFactorRecovery: (password, code) => req('POST', '/api/account/2fa/recovery', { password, code }),
  twoFactorDisable: (password, code) => req('POST', '/api/account/2fa/disable', { password, code }),

  // user CRUD (admin only)
  listUsers: () => req('GET', '/api/users'),
  createUser: (u) => req('POST', '/api/users', u),
  updateUser: (id, patch) => req('PUT', `/api/users/${encodeURIComponent(id)}`, patch),
  deleteUser: (id) => req('DELETE', `/api/users/${encodeURIComponent(id)}`),

  // device provisioning (list: any signed-in user; mutations: admin only)
  listDevices: () => req('GET', '/api/devices'),
  revealDevice: (id) => req('GET', `/api/devices/${encodeURIComponent(id)}/config`),
  createDevice: (d) => req('POST', '/api/devices', d),
  updateDevice: (id, patch) => req('PUT', `/api/devices/${encodeURIComponent(id)}`, patch),
  rotateDevice: (id) => req('POST', `/api/devices/${encodeURIComponent(id)}/rotate`),
  deleteDevice: (id) => req('DELETE', `/api/devices/${encodeURIComponent(id)}`),
  pairDevice: (id) => req('POST', `/api/devices/${encodeURIComponent(id)}/pair`),
  cancelPairing: (id) => req('DELETE', `/api/devices/${encodeURIComponent(id)}/pair`),
  claimPairing: (code) => req('POST', '/api/pair/claim', { code }),

  // device online/offline email alerts (admin only)
  alerts: () => req('GET', '/api/alerts'),
  saveAlerts: (patch) => req('PUT', '/api/alerts', patch),
  testAlert: () => req('POST', '/api/alerts/test'),
};
