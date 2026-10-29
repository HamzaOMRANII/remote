'use strict';

// In-memory rate limiting for the auth surfaces (login, 2FA, pairing, agent
// hello). Counts FAILURES per key in a sliding window; once a key hits `max`
// it is locked out until the oldest failure ages out. A success clears the key.
// Single process, no persistence — a restart resets counters, which is fine.

function createLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> [timestamps]

  function prune(key, now) {
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length) hits.set(key, arr); else hits.delete(key);
    return arr;
  }

  const sweep = setInterval(() => { const now = Date.now(); for (const k of hits.keys()) prune(k, now); }, windowMs);
  sweep.unref?.();

  return {
    // { ok: true } or { ok: false, retryAfter: seconds }
    check(key) {
      const now = Date.now();
      const arr = prune(key, now);
      if (arr.length < max) return { ok: true };
      return { ok: false, retryAfter: Math.ceil((arr[0] + windowMs - now) / 1000) };
    },
    fail(key) {
      const now = Date.now();
      const arr = prune(key, now);
      arr.push(now); hits.set(key, arr);
    },
    reset(key) { hits.delete(key); },
  };
}

// nginx sets X-Real-IP to the real client (Cloudflare's CF-Connecting-IP is
// already resolved there via set_real_ip_from). The app only listens on
// 127.0.0.1, so the header can't be forged by bypassing nginx.
function clientIp(req) {
  return req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

module.exports = { createLimiter, clientIp };
