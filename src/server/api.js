'use strict';

// Minimal JSON API: just the viewer auth surface for now. Realtime device
// traffic goes over the WebSocket (src/server/wss.js), not here.

const { sendJson, readJsonBody } = require('./http-util');

async function handle(req, res, pathname, { auth }) {
  // POST /api/login { password }
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!auth.checkPassword(body && body.password)) {
      return sendJson(res, 401, { error: 'Incorrect password.' });
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieFor() });
  }

  // POST /api/logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  // GET /api/me  — session probe for the client on boot
  if (pathname === '/api/me' && req.method === 'GET') {
    return sendJson(res, auth.isAuthed(req) ? 200 : 401, { authed: auth.isAuthed(req) });
  }

  return sendJson(res, 404, { error: 'not found' });
}

module.exports = { handle };
