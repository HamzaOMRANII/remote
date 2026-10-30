'use strict';

// In-memory device registry + request router. Single process, single box
// (same "one instance per box" stance as server_monitoring) — so a Map is
// enough; persistence can come later.
//
//  - agents register with HELLO and are tracked by device id
//  - viewers subscribe and receive the device list on change
//  - an action from a viewer is rewritten with a server-side reqId, forwarded
//    to the owning agent, and the agent's result is routed back to the exact
//    viewer that asked. Every action is audit-logged.

const crypto = require('node:crypto');

function createRegistry(events = {}) {
  const agents = new Map();      // deviceId -> { ws, device, capabilities, since }
  const viewers = new Set();     // Set<ws>
  const viewersById = new Map(); // viewerId -> ws
  const pending = new Map();      // serverReqId -> { viewerWs, clientReqId, device, cap, do, at }

  function deviceList() {
    return [...agents.values()].map(({ device, capabilities }) => ({
      id: device.id,
      name: device.name || device.id,
      platform: device.platform || 'unknown',
      online: true,
      capabilities,
    }));
  }

  function broadcastDevices() {
    const msg = JSON.stringify({ type: 'devices', devices: deviceList() });
    for (const v of viewers) {
      if (v.readyState === v.OPEN) v.send(msg);
    }
  }

  function addViewer(ws) {
    ws._viewerId = crypto.randomUUID();
    viewers.add(ws);
    viewersById.set(ws._viewerId, ws);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'devices', devices: deviceList() }));
    }
  }

  function removeViewer(ws) {
    viewers.delete(ws);
    if (ws._viewerId) viewersById.delete(ws._viewerId);
    // drop any pending requests owned by this viewer
    for (const [id, p] of pending) if (p.viewerWs === ws) pending.delete(id);
  }

  // WebRTC signaling relay -------------------------------------------------
  // Viewer -> agent: tag with the viewer's id so the agent can reply to it.
  function signalToAgent(viewerWs, msg) {
    const entry = agents.get(msg.device);
    if (!entry) return 'device offline';
    entry.ws.send(JSON.stringify({ type: 'signal', from: viewerWs._viewerId, data: msg.data }));
    return null;
  }

  // Agent -> viewer: route by the viewer id the agent is replying to.
  function signalToViewer(agentWs, msg) {
    const v = viewersById.get(msg.to);
    if (!v || v.readyState !== v.OPEN) return;
    v.send(JSON.stringify({ type: 'signal', from: agentWs._deviceId, data: msg.data }));
  }

  function addAgent(ws, device, capabilities) {
    // one connection per device id; replace a stale one
    const existing = agents.get(device.id);
    if (existing && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
      try { existing.ws.close(4001, 'replaced by a newer connection'); } catch {}
    }
    agents.set(device.id, { ws, device, capabilities, since: Date.now() });
    ws._deviceId = device.id;
    console.log(`[registry] agent online: ${device.id} (${capabilities.map((c) => c.cap).join(', ')})`);
    broadcastDevices();
    try { events.online?.(device); } catch (e) { console.error('[registry] online hook', e); }
  }

  function removeAgent(ws) {
    const id = ws._deviceId;
    if (id && agents.get(id)?.ws === ws) {
      const { device } = agents.get(id) || {};
      console.log(`[registry] agent offline: ${id}`);
      agents.delete(id);
      broadcastDevices();
      try { if (device) events.offline?.(device); } catch (e) { console.error('[registry] offline hook', e); }
    }
    for (const [rid, p] of pending) {
      if (p.device === id) {
        reply(p, { ok: false, error: 'device went offline' });
        pending.delete(rid);
      }
    }
  }

  function reply(p, body) {
    if (p.viewerWs.readyState === p.viewerWs.OPEN) {
      p.viewerWs.send(JSON.stringify({ type: 'result', reqId: p.clientReqId, ...body }));
    }
  }

  // Long-lived streaming ops (a running script's output, an open shell) must not
  // be timed out — they stay pending until the agent sends a final result or the
  // device disconnects.
  const isStreaming = (cap, op) => (cap === 'shell' && op === 'open') || (cap === 'scripts' && op === 'run');
  // High-frequency keystroke/resize traffic isn't worth an audit line.
  const isNoisy = (cap, op) => cap === 'shell' && (op === 'input' || op === 'resize');

  // Viewer asked to run an action on a device. Returns an error string if it
  // could not even be dispatched (caller may relay it), else null.
  function routeAction(viewerWs, msg) {
    const { device, cap, do: op, args, reqId: clientReqId } = msg;
    const entry = agents.get(device);
    if (!entry) return 'device offline';
    if (!entry.capabilities.some((c) => c.cap === cap)) return `device does not support "${cap}"`;

    const serverReqId = crypto.randomUUID();
    pending.set(serverReqId, { viewerWs, clientReqId, device, cap, do: op, at: Date.now() });

    if (!isNoisy(cap, op)) {
      const who = viewerWs._user ? ` user=${viewerWs._user}` : '';
      console.log(`[audit]${who} device=${device} cap=${cap} do=${op} args=${JSON.stringify(args || {})}`);
    }
    entry.ws.send(JSON.stringify({ type: 'action', reqId: serverReqId, cap, do: op, args }));

    if (!isStreaming(cap, op)) {
      setTimeout(() => {
        if (pending.has(serverReqId)) {
          reply(pending.get(serverReqId), { ok: false, error: 'timed out' });
          pending.delete(serverReqId);
        }
      }, 15000).unref?.();
    }
    return null;
  }

  // Agent sent a result/stream for a server reqId — route it back to the viewer.
  function routeFromAgent(msg) {
    const p = pending.get(msg.reqId);
    if (!p) return;
    if (msg.type === 'stream') {
      if (p.viewerWs.readyState === p.viewerWs.OPEN) {
        p.viewerWs.send(JSON.stringify({ type: 'stream', reqId: p.clientReqId, chunk: msg.chunk }));
      }
      return; // stream stays pending until the terminating result
    }
    reply(p, { ok: msg.ok, data: msg.data, error: msg.error });
    pending.delete(msg.reqId);
  }

  return {
    agents, viewers,
    addViewer, removeViewer, addAgent, removeAgent,
    routeAction, routeFromAgent, deviceList,
    signalToAgent, signalToViewer,
  };
}

module.exports = { createRegistry };
