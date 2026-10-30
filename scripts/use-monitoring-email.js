#!/usr/bin/env node
// One-time setup for Remote's email alerts: reuses the Gmail account (app password) that the
// monitoring console already sends with. Copies it into Remote's config.json → "smtp" (gitignored,
// mode 600). Prints nothing secret. Run:  node /projects/remote/scripts/use-monitoring-email.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MON = '/projects/server_monitoring/data/settings.json';
const CFG = path.join(__dirname, '..', 'config.json');

const email = JSON.parse(fs.readFileSync(MON, 'utf8')).receivers?.email;
if (!email?.smtp?.host || !email.smtp.user) { console.error('No email account set up in the monitoring console.'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
cfg.smtp = {
  host: email.smtp.host, port: email.smtp.port || 465, secure: email.smtp.secure !== false,
  user: email.smtp.user, pass: email.smtp.pass, from: `Remote <${email.from || email.smtp.user}>`,
};
cfg.timeZone = cfg.timeZone || 'Asia/Ho_Chi_Minh';
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(CFG, 0o600);
console.log(`Done: Remote will send alerts from ${email.smtp.user}. Now run: pm2 restart remote`);
