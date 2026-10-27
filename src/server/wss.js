'use strict';

// WebSocket layer: two upgrade paths on the same http server.
//
//   /ws     viewers  — authenticated by the session cookie at upgrade time
//   /agent  agents   — accept the socket, then require a valid HELLO (with the
//                      shared agent token) as the first message within a short
//                      window, or close. (Per-device keys replace this in M4.)
//
// A 30s heartbeat ping keeps connections alive through Cloudflare's ~100s idle
// cutoff and reaps dead sockets.

const { WebSocketServer } = require('ws');
const proto = require('../../protocol/messages');

const HELLO_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 30000;

function attach(server, { auth, registry }) {
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
      wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req));
      return;
    }

    socket.destroy();
  });

  // ---- viewers ----
  wssViewer.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    registry.addViewer(ws);

    ws.on('message', (raw) => {
      const msg = proto.safeParse(raw.toString());
      if (!msg) return;
      if (msg.type === proto.ACTION) {
        const err = registry.routeAction(ws, msg);
        if (err) ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, ok: false, error: err }));
      }
    });

    ws.on('close', () => registry.removeViewer(ws));
    ws.on('error', () => registry.removeViewer(ws));
  });

  // ---- agents ----
  wssAgent.on('connection', (ws) => {
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
        if (msg.type !== proto.HELLO || !auth.checkAgentToken(msg.token)) {
          try { ws.close(4003, 'auth failed'); } catch {}
          return;
        }
        if (!msg.device || !msg.device.id || !Array.isArray(msg.capabilities)) {
          try { ws.close(4002, 'bad hello'); } catch {}
          return;
        }
        ws.authed = true;
        clearTimeout(helloTimer);
        registry.addAgent(ws, msg.device, msg.capabilities);
        ws.send(JSON.stringify({ type: proto.HELLO_OK }));
        return;
      }

      if (msg.type === proto.RESULT || msg.type === proto.STREAM) {
        registry.routeFromAgent(msg);
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
