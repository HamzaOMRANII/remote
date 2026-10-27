'use strict';

// JSON API: viewer auth (username + password) and admin-only user CRUD.
// Realtime device traffic goes over the WebSocket (src/server/wss.js), not here.

const crypto = require('node:crypto');
const { sendJson, readJsonBody } = require('./http-util');

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
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    const user = users.verify(body && body.username, body && body.password);
    if (!user) return sendJson(res, 401, { error: 'Incorrect username or password.' });
    return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': auth.cookieFor(user) });
  }

  // POST /api/logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  // GET /api/me — who am I (session probe on boot)
  if (pathname === '/api/me' && req.method === 'GET') {
    const id = auth.identity(req);
    if (!id) return sendJson(res, 401, { authed: false });
    return sendJson(res, 200, { authed: true, username: id.u, role: id.r });
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
          return sendJson(res, 200, { user: users.update(id, body || {}) });
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (req.method === 'DELETE') {
        const actingId = (users.getByUsername(me.u) || {}).id;
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
