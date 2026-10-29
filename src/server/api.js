'use strict';

// JSON API: viewer auth (username + password, then TOTP when enabled), the
// signed-in user's account (password, 2FA), admin-only user CRUD, device
// provisioning and one-time pairing. Realtime device traffic goes over the
// WebSocket (src/server/wss.js), not here.
//
// Every credential-checking endpoint is rate limited on failures, per client
// IP and per account (src/server/ratelimit.js).

const crypto = require('node:crypto');
const { sendJson, readJsonBody } = require('./http-util');
const { createLimiter, clientIp } = require('./ratelimit');

const MIN = 60 * 1000;
const limits = {
  ip: createLimiter({ max: 20, windowMs: 15 * MIN }),      // any auth failure from one IP
  account: createLimiter({ max: 10, windowMs: 15 * MIN }), // password / code failures on one account
  pair: createLimiter({ max: 10, windowMs: 15 * MIN }),    // wrong pairing codes from one IP
};

// Check a set of limiter keys; on lockout answer 429 and return false.
function allowed(res, checks) {
  for (const [lim, key] of checks) {
    const r = lim.check(key);
    if (!r.ok) {
      sendJson(res, 429, { error: `Too many attempts — try again in ${Math.ceil(r.retryAfter / 60)} min.` },
        { 'Retry-After': String(r.retryAfter) });
      return false;
    }
  }
  return true;
}
const failAll = (checks) => checks.forEach(([lim, key]) => lim.fail(key));
const lc = (s) => String(s || '').toLowerCase();

// coturn REST-API time-limited credentials: username = "<unix-expiry>:<label>",
// password = base64(HMAC-SHA1(static-auth-secret, username)). Short-lived, so
// they're safe to hand out from the public /api/ice endpoint.
function turnCredentials(turn) {
  const ttl = turn.ttlSeconds || 3600;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:remote`;
  const credential = crypto.createHmac('sha1', turn.secret).update(username).digest('base64');
  const host = turn.host;
  return {
    username,
    credential,
    urls: [
      `turn:${host}:3478?transport=udp`,
      `turn:${host}:3478?transport=tcp`,
      `turns:${host}:5349?transport=tcp`,
    ],
    stun: `stun:${host}:3478`,
  };
}

async function handle(req, res, pathname, { auth, users, devices, registry, cfg }) {
  // GET /api/ice — WebRTC ICE servers (STUN always; TURN if configured in
  // config.server.turn). Public: the browser agent needs it before human login.
  if (pathname === '/api/ice' && req.method === 'GET') {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turn = cfg && cfg.server && cfg.server.turn;
    if (turn && turn.host && turn.secret) {
      const t = turnCredentials(turn);
      iceServers.unshift({ urls: t.stun });
      iceServers.push({ urls: t.urls, username: t.username, credential: t.credential });
    }
    return sendJson(res, 200, { iceServers });
  }

  // ---- auth ----

  // POST /api/login { username, password }
  //   no 2FA  -> session cookie
  //   2FA on  -> { needCode: true, ticket } (exchange at /api/login/code)
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    const ip = clientIp(req);
    const checks = [[limits.ip, ip], [limits.account, lc(body && body.username)]];
    if (!allowed(res, checks)) return;
    const user = users.verify(body && body.username, body && body.password);
    if (!user) {
      failAll(checks);
      console.log(`[auth] login failed user=${JSON.stringify(String((body && body.username) || '').slice(0, 40))} ip=${ip}`);
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    if (user.twoFactor) {
      return sendJson(res, 200, { needCode: true, ticket: auth.ticketFor(user) });
    }
    limits.account.reset(lc(user.username));
    console.log(`[auth] login ok user=${user.username} ip=${ip}`);
    return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': auth.cookieFor(user) });
  }

  // POST /api/login/code { ticket, code } — second step (TOTP or recovery code)
  if (pathname === '/api/login/code' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    const ip = clientIp(req);
    const u = auth.verifyTicket(body && body.ticket);
    if (!u) return sendJson(res, 401, { error: 'Sign-in expired — enter your password again.', restart: true });
    const checks = [[limits.ip, ip], [limits.account, lc(u.username)]];
    if (!allowed(res, checks)) return;
    const how = users.verifySecondFactor(u.username, body && body.code);
    if (!how) {
      failAll(checks);
      console.log(`[auth] 2fa failed user=${u.username} ip=${ip}`);
      return sendJson(res, 401, { error: 'Incorrect code.' });
    }
    limits.account.reset(lc(u.username));
    console.log(`[auth] login ok user=${u.username} ip=${ip} via=${how}`);
    const user = users.list().find((x) => x.id === u.id);
    return sendJson(res, 200, { ok: true, user, usedRecovery: how === 'recovery' }, { 'Set-Cookie': auth.cookieFor(user) });
  }

  // POST /api/logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  // GET /api/me — who am I (session probe on boot)
  if (pathname === '/api/me' && req.method === 'GET') {
    const id = auth.identity(req);
    if (!id) return sendJson(res, 401, { authed: false });
    return sendJson(res, 200, { authed: true, username: id.u, role: id.r, twoFactor: users.hasTwoFactor(id.u) });
  }

  // POST /api/verify-password { password, code? } — re-auth gate before
  // opening a shell; also needs a current code when the user has 2FA.
  if (pathname === '/api/verify-password' && req.method === 'POST') {
    const id = auth.identity(req);
    if (!id) return sendJson(res, 401, { error: 'unauthorized' });
    const body = await readJsonBody(req).catch(() => null);
    const checks = [[limits.account, lc(id.u)]];
    if (!allowed(res, checks)) return;
    let ok = !!users.verify(id.u, body && body.password);
    if (ok && users.hasTwoFactor(id.u)) ok = !!users.verifySecondFactor(id.u, body && body.code);
    if (!ok) failAll(checks);
    return sendJson(res, ok ? 200 : 401, ok ? { ok: true } : { error: users.hasTwoFactor(id.u) ? 'Incorrect password or code.' : 'Incorrect password.' });
  }

  // ---- my account: password + 2FA ----
  if (pathname.startsWith('/api/account')) {
    const id = auth.identity(req);
    if (!id) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = req.method === 'POST' ? await readJsonBody(req).catch(() => null) || {} : {};
    const me = users.list().find((u) => u.id === id.id);
    const checks = [[limits.account, lc(id.u)]];
    // sensitive changes re-check the password (and a code when 2FA is on)
    const reauth = (needCode) => {
      if (!allowed(res, checks)) return false;
      let ok = !!users.verify(id.u, body.password);
      if (ok && needCode) ok = !!users.verifySecondFactor(id.u, body.code);
      if (!ok) { failAll(checks); sendJson(res, 401, { error: needCode ? 'Incorrect password or code.' : 'Incorrect password.' }); }
      return ok;
    };
    const audit = (what) => console.log(`[auth] account user=${id.u} ${what} ip=${clientIp(req)}`);

    if (pathname === '/api/account' && req.method === 'GET') return sendJson(res, 200, { user: me });

    // { current, next } — signs out every other session (cookie is bound to the hash)
    if (pathname === '/api/account/password' && req.method === 'POST') {
      if (!allowed(res, checks)) return;
      try {
        const user = users.changePassword(id.id, body.current, body.next);
        audit('password changed');
        return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': auth.cookieFor(user) });
      } catch (e) {
        if (/incorrect/.test(e.message)) failAll(checks);
        return sendJson(res, 400, { error: e.message });
      }
    }
    // { password } -> { secret, uri } (pending until confirmed)
    if (pathname === '/api/account/2fa/setup' && req.method === 'POST') {
      if (me.twoFactor) return sendJson(res, 400, { error: '2FA is already on' });
      if (!reauth(false)) return;
      return sendJson(res, 200, users.beginTwoFactor(id.id));
    }
    // { code } -> { recoveryCodes } (shown once)
    if (pathname === '/api/account/2fa/enable' && req.method === 'POST') {
      if (!allowed(res, checks)) return;
      try {
        const recoveryCodes = users.enableTwoFactor(id.id, body.code);
        audit('2fa enabled');
        return sendJson(res, 200, { ok: true, recoveryCodes });
      } catch (e) { failAll(checks); return sendJson(res, 400, { error: e.message }); }
    }
    // { password, code } -> new recovery codes
    if (pathname === '/api/account/2fa/recovery' && req.method === 'POST') {
      if (!me.twoFactor) return sendJson(res, 400, { error: '2FA is not on' });
      if (!reauth(true)) return;
      audit('recovery codes regenerated');
      return sendJson(res, 200, { ok: true, recoveryCodes: users.regenerateRecovery(id.id) });
    }
    // { password, code }
    if (pathname === '/api/account/2fa/disable' && req.method === 'POST') {
      if (!me.twoFactor) return sendJson(res, 400, { error: '2FA is not on' });
      if (!reauth(true)) return;
      audit('2fa disabled');
      return sendJson(res, 200, { ok: true, user: users.disableTwoFactor(id.id) });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // ---- pairing claim (public: the device has no session, only the code) ----
  // POST /api/pair/claim { code } -> { device, token } once; the code is burnt.
  if (pathname === '/api/pair/claim' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    const ip = clientIp(req);
    const checks = [[limits.pair, ip]];
    if (!allowed(res, checks)) return;
    const got = devices.claimPairing(body && body.code);
    if (!got) {
      failAll(checks);
      console.log(`[pair] claim failed ip=${ip}`);
      return sendJson(res, 404, { error: 'Pairing code is invalid, used, or expired. Open a new one from the dashboard.' });
    }
    console.log(`[pair] device=${got.device.id} paired ip=${ip}`);
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    return sendJson(res, 200, {
      server: `${proto}://${req.headers.host}/agent`,
      token: got.token,
      device: { id: got.device.id, name: got.device.label },
    });
  }

  // ---- user CRUD (admin only) ----
  if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
    if (!auth.isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (!auth.isAdmin(req)) return sendJson(res, 403, { error: 'admin only' });
    const me = auth.identity(req);

    if (pathname === '/api/users' && req.method === 'GET') {
      return sendJson(res, 200, { users: users.list() });
    }
    if (pathname === '/api/users' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      try {
        return sendJson(res, 201, { user: users.create(body || {}) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    const m = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'PUT') {
        const body = await readJsonBody(req).catch(() => null);
        try {
          // admin recovery path: a user who lost their phone and codes
          if (body && body.resetTwoFactor) {
            console.log(`[auth] admin=${me.u} reset 2fa for user id=${id}`);
            return sendJson(res, 200, { user: users.disableTwoFactor(id) });
          }
          return sendJson(res, 200, { user: users.update(id, body || {}) });
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (req.method === 'DELETE') {
        const actingId = me.id;
        try {
          return sendJson(res, 200, users.remove(id, actingId));
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // ---- device provisioning ----
  if (pathname === '/api/devices' || pathname.startsWith('/api/devices/')) {
    if (!auth.isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });

    // list is available to any signed-in user; online status merged from the registry
    if (pathname === '/api/devices' && req.method === 'GET') {
      const online = new Set([...registry.agents.keys()]);
      return sendJson(res, 200, { devices: devices.list().map((d) => ({ ...d, online: online.has(d.id) })) });
    }

    // all mutations are admin-only
    if (!auth.isAdmin(req)) return sendJson(res, 403, { error: 'admin only' });

    if (pathname === '/api/devices' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      try { return sendJson(res, 201, devices.create(body || {})); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    // one-time pairing code (QR) — POST opens one, DELETE cancels it
    const pair = pathname.match(/^\/api\/devices\/([^/]+)\/pair$/);
    if (pair && (req.method === 'POST' || req.method === 'DELETE')) {
      const id = decodeURIComponent(pair[1]);
      try {
        if (req.method === 'DELETE') return sendJson(res, 200, devices.cancelPairing(id));
        console.log(`[pair] admin=${auth.identity(req).u} opened pairing device=${id}`);
        return sendJson(res, 200, devices.pair(id));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    const rot = pathname.match(/^\/api\/devices\/([^/]+)\/rotate$/);
    if (rot && req.method === 'POST') {
      try { return sendJson(res, 200, devices.rotate(decodeURIComponent(rot[1]))); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    // reveal the current token + config again (admin only)
    const rev = pathname.match(/^\/api\/devices\/([^/]+)\/config$/);
    if (rev && req.method === 'GET') {
      try { return sendJson(res, 200, devices.reveal(decodeURIComponent(rev[1]))); }
      catch (e) { return sendJson(res, 404, { error: e.message }); }
    }

    const one = pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (req.method === 'PUT') {
        const body = await readJsonBody(req).catch(() => null);
        try { return sendJson(res, 200, { device: devices.update(id, body || {}) }); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (req.method === 'DELETE') {
        try { return sendJson(res, 200, devices.remove(id)); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

module.exports = { handle };
