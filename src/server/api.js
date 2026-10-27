'use strict';

// JSON API: viewer auth (username + password) and admin-only user CRUD.
// Realtime device traffic goes over the WebSocket (src/server/wss.js), not here.

const { sendJson, readJsonBody } = require('./http-util');

async function handle(req, res, pathname, { auth, users }) {
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

  return sendJson(res, 404, { error: 'not found' });
}

module.exports = { handle };
