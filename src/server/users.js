'use strict';

// User store: username + scrypt-hashed password + role, persisted to
// data/users.json (gitignored). No DB dependency — a small JSON file is enough
// for self-use, matching the family's zero-dep stance. Admin is seeded on first
// boot from config (server.adminUser / server.password).
//
// Roles: "admin" (manage users + control devices) and "user" (control devices
// only). The last remaining admin cannot be deleted or demoted.
//
// 2FA (M4): optional per-user TOTP. Setup stores a pending secret until the
// user proves it with a code; enabling issues 10 one-time recovery codes
// (stored as sha256 — they are 50-bit random, so a fast hash is enough).
// The last accepted TOTP step is remembered so a code can't be replayed.

const fs = require('node:fs');
const { writeJson } = require('./jsonfile');
const path = require('node:path');
const crypto = require('node:crypto');

const ROLES = ['admin', 'user'];
const SCRYPT_KEYLEN = 64;
const totp = require('./totp');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normRecovery = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCodes(n = 10) {
  // xxxxx-xxxxx from an unambiguous alphabet
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(10);
    const s = Array.from(b, (x) => abc[x % abc.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt,
    twoFactor: !!u.totpEnabled, recoveryLeft: u.totpEnabled ? (u.recovery || []).length : 0,
  };
}

function create(cfg, root) {
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'users.json');
  let users = [];

  function save() { writeJson(file, users); }

  function load() {
    try {
      users = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(users)) users = [];
    } catch {
      users = [];
    }
  }

  function adminCount() {
    return users.filter((u) => u.role === 'admin').length;
  }

  load();

  // Seed the first admin from config if the store is empty.
  if (users.length === 0) {
    const username = (cfg.server.adminUser || 'admin').trim();
    const password = cfg.server.password || 'change-me';
    const { salt, hash } = hashPassword(password);
    users.push({
      id: crypto.randomUUID(), username, role: 'admin', salt, hash,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    save();
    console.log(`[users] seeded admin "${username}" from config.`);
  }

  return {
    list() {
      return users.map(publicUser);
    },
    getById(id) {
      return users.find((u) => u.id === id);
    },
    getByUsername(username) {
      return users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
    },
    verify(username, password) {
      const u = this.getByUsername(username);
      if (!u) {
        // spend a hash anyway to blunt username-timing probes
        hashPassword(password || '');
        return null;
      }
      return verifyPassword(password || '', u.salt, u.hash) ? publicUser(u) : null;
    },
    create({ username, password, role }) {
      username = String(username || '').trim();
      role = ROLES.includes(role) ? role : 'user';
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new Error('username must be 3–32 chars: letters, digits, . _ -');
      if (String(password || '').length < 6) throw new Error('password must be at least 6 characters');
      if (this.getByUsername(username)) throw new Error('username already exists');
      const { salt, hash } = hashPassword(password);
      const u = { id: crypto.randomUUID(), username, role, salt, hash, createdAt: Date.now(), updatedAt: Date.now() };
      users.push(u); save();
      return publicUser(u);
    },
    // ---- 2FA ----
    hasTwoFactor(username) {
      const u = this.getByUsername(username);
      return !!(u && u.totpEnabled);
    },
    // Accepts a current TOTP code (not replayed) or an unused recovery code.
    // Returns 'totp' | 'recovery' | null.
    verifySecondFactor(username, code) {
      const u = this.getByUsername(username);
      if (!u || !u.totpEnabled) return null;
      const step = totp.verify(u.totpSecret, code);
      if (step !== null && step > (u.totpLastStep || 0)) {
        u.totpLastStep = step; save();
        return 'totp';
      }
      const h = sha256(normRecovery(code));
      const list = u.recovery || [];
      if (normRecovery(code).length === 10 && list.includes(h)) {
        u.recovery = list.filter((x) => x !== h); u.updatedAt = Date.now(); save();
        return 'recovery';
      }
      return null;
    },
    beginTwoFactor(id) {
      const u = this.getById(id);
      if (!u) throw new Error('user not found');
      u.totpPending = totp.generateSecret(); save();
      return { secret: u.totpPending, uri: totp.otpauthUri(u.totpPending, u.username) };
    },
    enableTwoFactor(id, code) {
      const u = this.getById(id);
      if (!u) throw new Error('user not found');
      if (!u.totpPending) throw new Error('start the setup again');
      const step = totp.verify(u.totpPending, code);
      if (step === null) throw new Error('that code did not match — check the time on your phone and try again');
      const codes = newRecoveryCodes();
      Object.assign(u, {
        totpSecret: u.totpPending, totpEnabled: true, totpLastStep: step,
        recovery: codes.map((c) => sha256(normRecovery(c))), updatedAt: Date.now(),
      });
      delete u.totpPending; save();
      return codes;
    },
    regenerateRecovery(id) {
      const u = this.getById(id);
      if (!u || !u.totpEnabled) throw new Error('2FA is not enabled');
      const codes = newRecoveryCodes();
      u.recovery = codes.map((c) => sha256(normRecovery(c))); u.updatedAt = Date.now(); save();
      return codes;
    },
    disableTwoFactor(id) {
      const u = this.getById(id);
      if (!u) throw new Error('user not found');
      for (const k of ['totpSecret', 'totpEnabled', 'totpLastStep', 'totpPending', 'recovery']) delete u[k];
      u.updatedAt = Date.now(); save();
      return publicUser(u);
    },

    changePassword(id, current, next) {
      const u = this.getById(id);
      if (!u) throw new Error('user not found');
      if (!verifyPassword(current || '', u.salt, u.hash)) throw new Error('current password is incorrect');
      if (String(next || '').length < 10) throw new Error('new password must be at least 10 characters');
      Object.assign(u, hashPassword(next)); u.updatedAt = Date.now(); save();
      return publicUser(u);
    },

    update(id, { password, role, username }) {
      const u = users.find((x) => x.id === id);
      if (!u) throw new Error('user not found');
      if (role !== undefined && role !== u.role) {
        if (!ROLES.includes(role)) throw new Error('invalid role');
        if (u.role === 'admin' && role !== 'admin' && adminCount() <= 1) throw new Error('cannot demote the last admin');
        u.role = role;
      }
      if (username !== undefined && username.trim() && username.trim() !== u.username) {
        const name = username.trim();
        if (!/^[a-zA-Z0-9._-]{3,32}$/.test(name)) throw new Error('invalid username');
        if (this.getByUsername(name)) throw new Error('username already exists');
        u.username = name;
      }
      if (password) {
        if (String(password).length < 6) throw new Error('password must be at least 6 characters');
        Object.assign(u, hashPassword(password));
      }
      u.updatedAt = Date.now(); save();
      return publicUser(u);
    },
    remove(id, actingUserId) {
      const u = users.find((x) => x.id === id);
      if (!u) throw new Error('user not found');
      if (id === actingUserId) throw new Error('you cannot delete your own account');
      if (u.role === 'admin' && adminCount() <= 1) throw new Error('cannot delete the last admin');
      users = users.filter((x) => x.id !== id); save();
      return { ok: true };
    },
  };
}

module.exports = { create };
