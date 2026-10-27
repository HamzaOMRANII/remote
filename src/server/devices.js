'use strict';

// Device store: the "accesses" an admin provisions in the back office. Each
// device gets its own id + secret token, persisted to data/devices.json
// (gitignored). The agent logs in with { device.id, token }; the server
// validates per-device — revocable — instead of one shared token.
//
// Tokens are stored retrievably (not one-way hashed) on purpose: this is a
// self-hosted, single-operator tool and the admin wants to re-reveal / re-send
// a device's config at any time. The file is gitignored and lives only on the
// owner's box. Rotating a token invalidates the old one.
//
// Capabilities are advertised by the agent at connect time, not stored here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// What a normal list/response exposes — never the raw token.
function publicDevice(d) {
  return {
    id: d.id, label: d.label, enabled: d.enabled,
    tokenPrefix: (d.token || '').slice(0, 6),
    createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || null,
  };
}

function create(cfg, root) {
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'devices.json');
  let devices = [];

  function save() { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(devices, null, 2) + '\n'); }
  function load() {
    try { devices = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(devices)) devices = []; }
    catch { devices = []; }
  }
  load();

  function uniqueId(base) {
    let id = base, n = 2;
    while (devices.some((d) => d.id === id)) { id = `${base}-${n++}`.slice(0, 40); }
    return id;
  }

  return {
    list() { return devices.map(publicDevice); },
    get(id) { return devices.find((d) => d.id === id); },

    // Create. id is optional — derived from the name when omitted.
    create({ id, label }) {
      label = String(label || '').trim();
      id = String(id || '').trim().toLowerCase();
      if (!id) {
        const slug = slugify(label);
        if (slug.length < 2) throw new Error('enter a name (or an id) at least 2 characters long');
        id = uniqueId(slug);
      }
      if (!ID_RE.test(id)) throw new Error('id must be 2–40 chars: lowercase letters, digits, hyphen');
      if (this.get(id)) throw new Error('a device with that id already exists');
      const token = newToken();
      const d = { id, label: label || id, enabled: true, token, createdAt: Date.now(), lastSeenAt: null };
      devices.push(d); save();
      return { device: publicDevice(d), token };
    },

    // Re-reveal the current token + config any time (admin only, via API).
    reveal(id) {
      const d = this.get(id);
      if (!d) throw new Error('device not found');
      return { device: publicDevice(d), token: d.token };
    },

    update(id, { label, enabled }) {
      const d = this.get(id);
      if (!d) throw new Error('device not found');
      if (label !== undefined && String(label).trim()) d.label = String(label).trim();
      if (enabled !== undefined) d.enabled = !!enabled;
      save();
      return publicDevice(d);
    },

    rotate(id) {
      const d = this.get(id);
      if (!d) throw new Error('device not found');
      d.token = newToken();
      save();
      return { device: publicDevice(d), token: d.token };
    },

    remove(id) {
      if (!this.get(id)) throw new Error('device not found');
      devices = devices.filter((d) => d.id !== id); save();
      return { ok: true };
    },

    verifyToken(id, token) {
      const d = this.get(id);
      if (!d || !d.enabled) return false;
      return constantTimeEquals(token || '', d.token);
    },

    touch(id) {
      const d = this.get(id);
      if (d) { d.lastSeenAt = Date.now(); save(); }
    },
  };
}

module.exports = { create };
