'use strict';

// Password-session login gate for viewers, plus a shared-token check for
// agents. No session store or deps: on login we hand out an httpOnly cookie
// holding an HMAC-signed, time-limited token; every protected request (and the
// viewer WebSocket upgrade) re-verifies the signature.
//
// M4 hardening:
//   - sessions are bound to the user's current password hash ("pv"), so a
//     password change or account deletion signs out every old cookie, and the
//     role is read live from the store (a demotion takes effect immediately);
//   - when the user has 2FA, the password step only yields a 5-minute "ticket"
//     (a different payload kind, never accepted as a session) that the TOTP
//     step exchanges for the real cookie.
// See ARCHITECTURE.md §6.

const crypto = require('node:crypto');
const { parseCookies } = require('./http-util');

const COOKIE = 'remote_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h
const TICKET_MS = 5 * 60 * 1000;

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

function create(cfg, users) {
  const secret = cfg.server.sessionSecret || 'insecure-dev-secret';
  const pv = (u) => u.hash.slice(0, 16);

  return {
    // Returns the session payload { u: username, r: role } or null.
    identity(req) {
      const p = verify(parseCookies(req)[COOKIE], secret);
      if (!p || p.k) return null;
      const u = users.getByUsername(p.u);
      if (!u || !p.pv || !constantTimeEquals(p.pv, pv(u))) return null;
      return { u: u.username, r: u.role, id: u.id };
    },
    isAuthed(req) {
      return !!this.identity(req);
    },
    isAdmin(req) {
      const id = this.identity(req);
      return !!id && id.r === 'admin';
    },
    // second-step ticket after a correct password when 2FA is on
    ticketFor(user) {
      const u = users.getByUsername(user.username);
      return sign({ k: '2fa', u: u.username, pv: pv(u), exp: Date.now() + TICKET_MS }, secret);
    },
    verifyTicket(ticket) {
      const p = verify(ticket, secret);
      if (!p || p.k !== '2fa') return null;
      const u = users.getByUsername(p.u);
      if (!u || !constantTimeEquals(p.pv, pv(u))) return null;
      return u;
    },
    cookieFor(user) {
      const u = users.getByUsername(user.username);
      const token = sign({ u: u.username, pv: pv(u), exp: Date.now() + MAX_AGE_MS }, secret);
      return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}`;
    },
    clearCookie() {
      return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
    },
  };
}

module.exports = { create };
