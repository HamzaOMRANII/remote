'use strict';
// Safe JSON saves for data/*.json (users, devices).
//  - atomic: write a temp file, fsync, rename — a crash mid-save never leaves a half-written file
//  - daily history: the first save of each day also keeps data/history/<name>-YYYY-MM-DD.json
//    (last 14 days) — a quick undo for a bad change, on top of the nightly server backup
// Files are written with mode 600: they hold password hashes and 2FA secrets.
const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 14;

function writeJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  snapshot(file);
  fs.renameSync(tmp, file);
}

// keeps yesterday's (or older) version before today's first change
function snapshot(file) {
  try {
    if (!fs.existsSync(file)) return;
    const hist = path.join(path.dirname(file), 'history');
    const base = path.basename(file, '.json');
    const day = new Date().toISOString().slice(0, 10);
    const dest = path.join(hist, `${base}-${day}.json`);
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(hist, { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o600);
    const old = fs.readdirSync(hist).filter((f) => f.startsWith(`${base}-`) && f.endsWith('.json')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_DAYS))) fs.unlinkSync(path.join(hist, f));
  } catch (e) {
    console.warn('[remote] history snapshot failed:', e.message);
  }
}

module.exports = { writeJson };
