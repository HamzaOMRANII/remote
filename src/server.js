/**
 * App server for remote.omranisystems.com.
 *
 * Same shape as server_monitoring/src/server.js — a near-zero-dependency Node
 * http server that serves the Vite build (./dist) behind nginx — extended with:
 *   - /api/*        viewer auth (login/logout/me)
 *   - /ws, /agent   WebSocket upgrades (src/server/wss.js): viewers and device
 *                   agents, routed through an in-memory registry
 *   - a login gate on the SPA: unauthenticated page loads redirect to /login
 *   - /healthz      for pm2 / uptime checks
 *
 * Runtime dependency: ws. Env: PORT (default 16010), HOST (default 127.0.0.1).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { load, ROOT } = require('./server/config');
const authFactory = require('./server/auth');
const usersFactory = require('./server/users');
const devicesFactory = require('./server/devices');
const api = require('./server/api');
const { createRegistry } = require('./server/registry');
const { attach } = require('./server/wss');
const { sendText } = require('./server/http-util');

const cfg = load();
const users = usersFactory.create(cfg, ROOT);
const devices = devicesFactory.create(cfg, ROOT);
const auth = authFactory.create(cfg, users);
const registry = createRegistry();

const PORT = cfg.server.port || 16010;
const HOST = cfg.server.host || '127.0.0.1';
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(req, res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(DIST, file).split(path.sep).join('/');
  const hashed = rel.startsWith('assets/');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(status, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': st.size,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (pathname === '/healthz') {
    return sendText(res, 200, 'ok', { 'Cache-Control': 'no-store' });
  }

  if (pathname.startsWith('/api/')) {
    try {
      await api.handle(req, res, pathname, { auth, users, devices, registry, cfg });
    } catch (err) {
      console.error('[remote] api error:', err.message);
      if (!res.headersSent) sendText(res, 500, 'Internal error');
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  const target = path.normalize(path.join(DIST, pathname));
  if (target !== DIST && !target.startsWith(DIST + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  const isRoute = pathname.endsWith('/') || !path.extname(pathname);
  if (isRoute) {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    // /login and /connect (the browser agent) are reachable without a human
    // session — /connect authenticates with the device's own access token.
    const openRoutes = normalized === '/login' || normalized === '/connect';
    if (!openRoutes && !auth.isAuthed(req)) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (!fs.existsSync(INDEX)) {
      return sendText(res, 500, 'Build missing — run "npm run build".');
    }
    return serveFile(req, res, INDEX);
  }

  serveFile(req, res, target);
});

attach(server, { auth, registry, devices });

server.listen(PORT, HOST, () => {
  console.log(`[remote] listening on http://${HOST}:${PORT}  (ws: /ws, agents: /agent)`);
  if (!cfg.server.password || cfg.server.password.startsWith('change-me')) {
    console.warn('[remote] WARNING: default/empty admin password — set a real one before exposing.');
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
