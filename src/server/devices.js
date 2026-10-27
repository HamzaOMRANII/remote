'use strict';

// Device store: the "accesses" an admin provisions in the back office. Each
// device gets its own id + secret token (scrypt-hashed, shown once at creation
// or rotation), persisted to data/devices.json (gitignored). The agent logs in
// with { device.id, token }; the server validates the token against THIS store
// — per-device, revocable — instead of one shared token. This is the M4
// per-device-credential goal, pulled forward because provisioning is the point
// of the CRUD.
//
// Capabilities are advertised by the agent at connect time, not stored here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEYLEN = 64;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function newToken() { return crypto.randomBytes(24).toString('hex'); }
function hashToken(token, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(token), salt, KEYLEN).toString('hex') };
}
function verify(token, salt, hash) {
  const a = crypto.scryptSync(String(token), salt, KEYLEN);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function publicDevice(d) {
  return {
    id: d.id, label: d.label, enabled: d.enabled,
    tokenPrefix: d.tokenPrefix, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || null,
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

  return {
    list() { return devices.map(publicDevice); },
    get(id) { return devices.find((d) => d.id === id); },

    // Returns a token string the agent must save (shown once).
    create({ id, label }) {
      id = String(id || '').trim().toLowerCase();
      if (!ID_RE.test(id)) throw new Error('id must be 2–40 chars: lowercase letters, digits, hyphen');
      if (this.get(id)) throw new Error('a device with that id already exists');
      const token = newToken();
      const { salt, hash } = hashToken(token);
      const d = {
        id, label: String(label || id).trim(), enabled: true,
        salt, hash, tokenPrefix: token.slice(0, 6),
        createdAt: Date.now(), lastSeenAt: null,
      };
      devices.push(d); save();
      return { device: publicDevice(d), token };
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
      const token = newToken();
      Object.assign(d, hashToken(token));
      d.tokenPrefix = token.slice(0, 6);
      save();
      return { device: publicDevice(d), token };
    },

    remove(id) {
      if (!this.get(id)) throw new Error('device not found');
      devices = devices.filter((d) => d.id !== id); save();
      return { ok: true };
    },

    // Agent auth: id + token must match an enabled device.
    verifyToken(id, token) {
      const d = this.get(id);
      if (!d || !d.enabled) return false;
      return verify(token || '', d.salt, d.hash);
    },

    touch(id) {
      const d = this.get(id);
      if (d) { d.lastSeenAt = Date.now(); save(); }
    },
  };
}

module.exports = { create };
