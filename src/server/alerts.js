'use strict';
// Device online/offline email alerts.
//
//   offline: emailed only after the device stayed away for `graceMin` minutes (a phone switching networks
//            or the server restarting reconnects well within that and sends nothing)
//   online:  "back online" only for a device we emailed about going offline
//
// Flood guards: one offline email per device per 15 min, at most 20 emails per hour in total.
// Settings (admin, Account page) live in data/alerts.json; the SMTP account in config.json → "smtp"
// (the same Gmail app password as the monitoring console). No SMTP config = alerts can't be turned on.
const path = require('node:path');
const fs = require('node:fs');
const nodemailer = require('nodemailer');
const { writeJson } = require('./jsonfile');

const MIN = 60 * 1000;
const DEVICE_COOLDOWN = 15 * MIN;
const MAX_PER_HOUR = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function create(cfg, root, devices) {
  const file = path.join(root, 'data', 'alerts.json');
  const smtp = cfg.smtp && cfg.smtp.host ? cfg.smtp : null;
  let settings = { enabled: false, to: [], graceMin: 2, muted: [] }; // muted: device ids without alerts
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}

  const timers = new Map();    // deviceId -> pending offline timer
  const alerted = new Map();   // deviceId -> time we emailed "offline"
  const lastOffline = new Map(); // deviceId -> last offline email time (cooldown)
  let sent = [];               // send times in the last hour

  const nameOf = (id, fallback) => (devices.get(id) && devices.get(id).label) || fallback || id;
  const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: cfg.timeZone || 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' });
  const mins = (ms) => { const m = Math.round(ms / MIN); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const active = () => !!(smtp && settings.enabled && settings.to.length);
  const watched = (id) => !settings.muted.includes(id);

  async function send(subject, text, { force = false } = {}) {
    if (!smtp) return { ok: false, error: 'Email is not set up on the server (config.json → smtp).' };
    const now = Date.now();
    sent = sent.filter((t) => now - t < 60 * MIN);
    if (!force && sent.length >= MAX_PER_HOUR) { console.warn('[alerts] hourly limit reached, dropped:', subject); return { ok: false, error: 'limit' }; }
    sent.push(now);
    try {
      await nodemailer.createTransport({
        host: smtp.host, port: smtp.port || 465, secure: smtp.secure !== false,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      }).sendMail({ from: smtp.from || smtp.user, to: settings.to.join(', '), subject, text });
      console.log('[alerts] sent:', subject);
      return { ok: true };
    } catch (e) {
      console.error('[alerts] email error:', e.message);
      return { ok: false, error: e.message };
    }
  }

  function online(device) {
    const id = device.id;
    clearTimeout(timers.get(id));
    timers.delete(id);
    const since = alerted.get(id);
    if (since === undefined) return;
    alerted.delete(id);
    if (!active() || !watched(id)) return;
    send(`✅ Remote: ${nameOf(id, device.name)} is back online`,
      `${nameOf(id, device.name)} reconnected at ${when(Date.now())} after about ${mins(Date.now() - since + settings.graceMin * MIN)} offline.\n\nhttps://remote.omranisystems.com/`);
  }

  function offline(device) {
    const id = device.id;
    if (!active() || !watched(id)) return;
    clearTimeout(timers.get(id));
    const wentAt = Date.now();
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      if (!active() || !watched(id)) return;
      const last = lastOffline.get(id) || 0;
      if (Date.now() - last < DEVICE_COOLDOWN) return; // flapping: stay quiet
      lastOffline.set(id, Date.now());
      alerted.set(id, Date.now());
      send(`📴 Remote: ${nameOf(id, device.name)} went offline`,
        `${nameOf(id, device.name)} disconnected at ${when(wentAt)} and has not come back for ${settings.graceMin} min.\n` +
        `For a phone: check its battery and internet, or open the Remote app (Android may have paused sharing).\n\n` +
        `You will get another email when it is back online.\nhttps://remote.omranisystems.com/`);
    }, settings.graceMin * MIN));
  }

  function publicSettings() {
    return { ...settings, smtpReady: !!smtp, from: smtp ? (smtp.from || smtp.user) : '' };
  }

  function update(body) {
    const next = { ...settings };
    if (body.enabled !== undefined) next.enabled = !!body.enabled;
    if (body.to !== undefined) {
      const list = (Array.isArray(body.to) ? body.to : String(body.to).split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean);
      const bad = list.find((e) => !EMAIL_RE.test(e));
      if (bad) throw new Error(`Not an email address: ${bad}`);
      if (list.length > 5) throw new Error('At most 5 addresses.');
      next.to = list;
    }
    if (body.graceMin !== undefined) {
      const g = Number(body.graceMin);
      if (!Number.isFinite(g) || g < 1 || g > 120) throw new Error('Wait time must be 1–120 minutes.');
      next.graceMin = Math.round(g);
    }
    if (body.muted !== undefined) next.muted = (Array.isArray(body.muted) ? body.muted : []).map(String).slice(0, 500);
    if (next.enabled && !smtp) throw new Error('Email is not set up on the server.');
    if (next.enabled && !next.to.length) throw new Error('Add an email address first.');
    settings = next;
    writeJson(file, settings);
    if (!active()) { for (const t of timers.values()) clearTimeout(t); timers.clear(); }
    return publicSettings();
  }

  function test() {
    if (!settings.to.length) return Promise.resolve({ ok: false, error: 'Add an email address first.' });
    return send('✅ Remote: test alert', `This is a test from Remote (remote.omranisystems.com).\nDevice alerts will arrive like this.\n${when(Date.now())}`, { force: true });
  }

  return { online, offline, settings: publicSettings, update, test };
}

module.exports = { create };
