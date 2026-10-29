'use strict';

// WebSocket layer: two upgrade paths on the same http server.
//
//   /ws     viewers  — authenticated by the session cookie at upgrade time
//   /agent  agents   — accept the socket, then require a valid HELLO (device
//                      id + its own token) as the first message within a short
//                      window, or close. An IP that keeps failing is refused at
//                      the upgrade for a while (rate limit).
//
// A 30s heartbeat ping keeps connections alive through Cloudflare's ~100s idle
// cutoff and reaps dead sockets.

const { WebSocketServer } = require('ws');
const proto = require('../../protocol/messages');
const { createLimiter, clientIp } = require('./ratelimit');

const HELLO_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 30000;
const agentFails = createLimiter({ max: 20, windowMs: 10 * 60 * 1000 });

function attach(server, { auth, registry, devices }) {
  const wssViewer = new WebSocketServer({ noServer: true });
  const wssAgent = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === '/ws') {
      if (!auth.isAuthed(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wssViewer.handleUpgrade(req, socket, head, (ws) => wssViewer.emit('connection', ws, req));
      return;
    }

    if (pathname === '/agent') {
      if (!agentFails.check(clientIp(req)).ok) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req));
      return;
    }

    socket.destroy();
  });

  // ---- viewers ----
  wssViewer.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const id = auth.identity(req);
    ws._user = id && id.u;
    ws._role = id && id.r;
    registry.addViewer(ws);

    ws.on('message', (raw) => {
      const msg = proto.safeParse(raw.toString());
      if (!msg) return;
      if (msg.type === proto.ACTION) {
        // the shell is admin-only (powerful + physical-adjacent); scripts/gpio/camera are open to any signed-in viewer
        if (msg.cap === 'shell' && ws._role !== 'admin') {
          return ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, ok: false, error: 'shell is admin only' }));
        }
        const err = registry.routeAction(ws, msg);
        if (err) ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, ok: false, error: err }));
      } else if (msg.type === proto.SIGNAL) {
        const err = registry.signalToAgent(ws, msg);
        if (err) ws.send(JSON.stringify({ type: 'signal', from: msg.device, data: { kind: 'error', error: err } }));
      }
    });

    ws.on('close', () => registry.removeViewer(ws));
    ws.on('error', () => registry.removeViewer(ws));
  });

  // ---- agents ----
  wssAgent.on('connection', (ws, req) => {
    const ip = clientIp(req);
    ws.isAlive = true;
    ws.authed = false;
    ws.on('pong', () => { ws.isAlive = true; });

    const helloTimer = setTimeout(() => {
      if (!ws.authed) {
        try { ws.close(4003, 'no hello'); } catch {}
      }
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw) => {
      const msg = proto.safeParse(raw.toString());
      if (!msg) return;

      if (!ws.authed) {
        if (msg.type !== proto.HELLO || !msg.device || !msg.device.id || !Array.isArray(msg.capabilities)) {
          try { ws.close(4002, 'bad hello'); } catch {}
          return;
        }
        // per-device credential: the id + token must match a provisioned, enabled device
        if (!devices.verifyToken(msg.device.id, msg.token)) {
          agentFails.fail(ip);
          console.log(`[auth] agent hello failed device=${JSON.stringify(String(msg.device.id).slice(0, 40))} ip=${ip}`);
          try { ws.close(4003, 'auth failed'); } catch {}
          return;
        }
        ws.authed = true;
        agentFails.reset(ip);
        clearTimeout(helloTimer);
        devices.touch(msg.device.id);
        const prov = devices.get(msg.device.id);
        const device = { ...msg.device, name: (prov && prov.label) || msg.device.name || msg.device.id };
        registry.addAgent(ws, device, msg.capabilities);
        ws.send(JSON.stringify({ type: proto.HELLO_OK }));
        return;
      }

      if (msg.type === proto.RESULT || msg.type === proto.STREAM) {
        registry.routeFromAgent(msg);
      } else if (msg.type === proto.SIGNAL) {
        registry.signalToViewer(ws, msg);
      }
    });

    ws.on('close', () => { clearTimeout(helloTimer); registry.removeAgent(ws); });
    ws.on('error', () => { clearTimeout(helloTimer); registry.removeAgent(ws); });
  });

  // ---- heartbeat ----
  const beat = setInterval(() => {
    for (const wss of [wssViewer, wssAgent]) {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, PING_INTERVAL_MS);
  beat.unref?.();

  return { wssViewer, wssAgent };
}

module.exports = { attach };
