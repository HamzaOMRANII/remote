'use strict';

// The capability protocol — the one contract every device and feature plugs
// into (ARCHITECTURE.md §4). CommonJS so the Node backend can require() it;
// the client mirrors these string constants in src/client/ws.js (kept trivial
// so the two module systems don't fight). Change them in both places.
//
// Envelope: every message is JSON with a `type`. Request/response pairs carry
// a `reqId`. Streaming replies send `stream` chunks keyed by reqId, ended by a
// `result`.

// Agent -> server
const HELLO = 'hello';        // { type, token, device:{id,name,platform}, capabilities:[...] }
const RESULT = 'result';      // { type, reqId, ok, data?, error? }
const STREAM = 'stream';      // { type, reqId, chunk }   (terminal/script output, discovery results)
const CAPS = 'caps';          // { type, capabilities:[...] }  capabilities changed (e.g. joined the owner's Wi-Fi)

// Server -> agent
const HELLO_OK = 'hello-ok';  // { type }
const ACTION = 'action';      // { type, reqId, cap, do, args }

// Server -> viewer
const DEVICES = 'devices';    // { type, devices:[{ id, name, platform, online, capabilities }] }
const ERROR = 'error';        // { type, error }

// WebRTC signaling, relayed between a viewer and a device agent (camera).
//   viewer -> server: { type:'signal', device, data }      (server adds from=<viewerId>)
//   server -> agent:  { type:'signal', from:<viewerId>, data }
//   agent  -> server: { type:'signal', to:<viewerId>, data } (server sets from=<deviceId>)
//   server -> viewer: { type:'signal', from:<deviceId>, data }
// data.kind is one of: request | offer | answer | ice
const SIGNAL = 'signal';

// Viewer -> server: ACTION  { type, reqId, device, cap, do, args }
//   (server rewrites reqId before forwarding to the agent, maps the result back)

// Capability identifiers
const CAP = {
  CAMERA: 'camera',
  GPIO: 'gpio',
  SCRIPTS: 'scripts',
  SHELL: 'shell',
  MEDIA: 'media',
  DISCOVERY: 'discovery', // { cap, network:{name, subnet} } while on the owner's network; do: scan (streams hosts)
};

function safeParse(raw) {
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && typeof m.type === 'string' ? m : null;
  } catch {
    return null;
  }
}

module.exports = {
  HELLO, RESULT, STREAM, CAPS, HELLO_OK, ACTION, DEVICES, ERROR, SIGNAL, CAP, safeParse,
};
