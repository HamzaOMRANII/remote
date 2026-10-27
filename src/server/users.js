'use strict';

// User store: username + scrypt-hashed password + role, persisted to
// data/users.json (gitignored). No DB dependency — a small JSON file is enough
// for self-use, matching the family's zero-dep stance. Admin is seeded on first
// boot from config (server.adminUser / server.password).
//
// Roles: "admin" (manage users + control devices) and "user" (control devices
// only). The last remaining admin cannot be deleted or demoted.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROLES = ['admin', 'user'];
const SCRYPT_KEYLEN = 64;

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
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt };
}

function create(cfg, root) {
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'users.json');
  let users = [];

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(users, null, 2) + '\n');
  }

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
