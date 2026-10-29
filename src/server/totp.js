'use strict';

// TOTP (RFC 6238, SHA-1, 6 digits, 30 s step) — what Google Authenticator,
// Authy, 1Password, Aegis etc. expect. Zero-dep: node:crypto + a tiny base32.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit, the RFC 4226 recommendation
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Returns the matched time step (so callers can refuse replays), or null.
// window=1 accepts the previous/next 30 s step for clock drift.
function verify(secret, code, { window = 1, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / 1000 / STEP);
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(codeAt(secret, cur + d));
    if (crypto.timingSafeEqual(expected, Buffer.from(c))) return cur + d;
  }
  return null;
}

function otpauthUri(secret, account, issuer = 'Remote') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

module.exports = { generateSecret, verify, otpauthUri, codeAt, base32Decode, STEP };
