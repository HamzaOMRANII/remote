// Viewer WebSocket client: one connection to /ws, auto-reconnecting, exposed
// to React through a tiny store + useRemote() hook.
//
// It mirrors the protocol string constants from protocol/messages.js (kept
// duplicated so the ESM client and CommonJS server don't fight over modules —
// change both if the protocol changes).
import { useEffect, useState } from 'react';

const T = { ACTION: 'action', RESULT: 'result', STREAM: 'stream', DEVICES: 'devices', ERROR: 'error', SIGNAL: 'signal' };

let sock = null;
let backoff = 1000;
let reqSeq = 0;
const pending = new Map();           // reqId -> { resolve, reject, timer }
const streams = new Map();           // reqId -> { onChunk, resolve, reject }  (streaming actions)
const state = { connected: false, devices: [] };
const listeners = new Set();
const signalListeners = new Map();   // deviceId -> Set(cb)  (incoming WebRTC signals)

function emit() {
  for (const l of listeners) l({ ...state });
}

function wsUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

function connect() {
  if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
  sock = new WebSocket(wsUrl());

  sock.onopen = () => {
    backoff = 1000;
    state.connected = true;
    emit();
  };

  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === T.DEVICES) {
      state.devices = msg.devices || [];
      emit();
    } else if (msg.type === T.RESULT) {
      const s = streams.get(msg.reqId);
      if (s) {
        streams.delete(msg.reqId);
        msg.ok ? s.resolve(msg.data) : s.reject(new Error(msg.error || 'failed'));
        return;
      }
      const p = pending.get(msg.reqId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.reqId);
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'failed'));
      }
    } else if (msg.type === T.STREAM) {
      const s = streams.get(msg.reqId);
      if (s) s.onChunk(msg.chunk);
    } else if (msg.type === T.SIGNAL) {
      const set = signalListeners.get(msg.from);
      if (set) for (const cb of set) cb(msg.data);
    }
  };

  const down = () => {
    state.connected = false;
    emit();
    sock = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
  sock.onclose = down;
  sock.onerror = () => { try { sock.close(); } catch {} };
}

// Run an action on a device; resolves with the agent's result data.
function action(device, cap, op, args) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
    const reqId = `v${++reqSeq}`;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error('timed out'));
    }, 20000);
    pending.set(reqId, { resolve, reject, timer });
    sock.send(JSON.stringify({ type: T.ACTION, reqId, device, cap, do: op, args }));
  });
}

// Streaming action (scripts, shell): chunks arrive via onChunk; the returned
// promise (`done`) resolves with the final result data (or rejects on error).
// `reqId` lets you nothing more — input/resize target the agent by args.sid.
function runStream(device, cap, op, args, onChunk) {
  const reqId = `v${++reqSeq}`;
  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });
  streams.set(reqId, { onChunk, resolve, reject });
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify({ type: T.ACTION, reqId, device, cap, do: op, args }));
  } else { streams.delete(reqId); reject(new Error('not connected')); }
  return { reqId, done };
}

// Fire-and-forget action (shell input/resize/close): we don't track the result.
function sendAction(device, cap, op, args) {
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify({ type: T.ACTION, reqId: `v${++reqSeq}`, device, cap, do: op, args }));
  }
}

// WebRTC signaling for the camera: send to a device, subscribe to replies.
function sendSignal(device, data) {
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify({ type: T.SIGNAL, device, data }));
  }
}
function onSignal(device, cb) {
  if (!signalListeners.has(device)) signalListeners.set(device, new Set());
  signalListeners.get(device).add(cb);
  return () => { const s = signalListeners.get(device); if (s) s.delete(cb); };
}

export function useRemote() {
  const [snap, setSnap] = useState({ ...state });
  useEffect(() => {
    listeners.add(setSnap);
    connect();
    return () => listeners.delete(setSnap);
  }, []);
  return { ...snap, action, runStream, sendAction, sendSignal, onSignal };
}
