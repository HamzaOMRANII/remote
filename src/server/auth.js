'use strict';

// Password-session login gate for viewers, plus a shared-token check for
// agents. No session store or deps: on login we hand out an httpOnly cookie
// holding an HMAC-signed, time-limited token; every protected request (and the
// viewer WebSocket upgrade) re-verifies the signature.
//
// Intentionally simple for v1 (self-use). The M4 hardening milestone replaces
// the shared agent token with per-device keys + pairing, and adds 2FA on the
// viewer. See ARCHITECTURE.md §6. Until then, keep this behind TLS and ideally
// an IP allowlist / VPN.

const crypto = require('node:crypto');
const { parseCookies } = require('./http-util');

const COOKIE = 'remote_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // spend the compare to avoid length timing leak
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function create(cfg) {
  const secret = cfg.server.sessionSecret || 'insecure-dev-secret';

  return {
    // Returns the session payload { u: username, r: role } or null.
    identity(req) {
      return verify(parseCookies(req)[COOKIE], secret);
    },
    isAuthed(req) {
      return !!this.identity(req);
    },
    isAdmin(req) {
      const id = this.identity(req);
      return !!id && id.r === 'admin';
    },
    cookieFor(user) {
      const token = sign({ u: user.username, r: user.role, exp: Date.now() + MAX_AGE_MS }, secret);
      return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}`;
    },
    clearCookie() {
      return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },
  };
}

module.exports = { create };
