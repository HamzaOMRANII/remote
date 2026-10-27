# Remote — server + viewer

Self-hosted remote access to **your own devices** from one private dashboard:
view a camera, flip a GPIO pin, run a script, open a shell. This repo is the
**server + web viewer** (deployed at `remote.omranisystems.com`). The device
agent lives in a separate repo: [`remote_agent`](https://github.com/HamzaOMRANII/remote_agent).

Full design: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Part of the Omrani Systems family — it reuses the `server_monitoring` /
`it.omranisystems.com` design system (navy + petrol, Sora / Inter / JetBrains
Mono, glass cards, console frames).

## Status — M1 (vertical slice) · LIVE

**Deployed:** https://remote.omranisystems.com (pm2 app `remote` on 127.0.0.1:16010, nginx vhost, Cloudflare). See [`deploy/INSTALL.md`](./deploy/INSTALL.md).

- ✅ Zero-dep Node server + `ws`: static SPA serving, `/healthz`.
- ✅ **User accounts**: username + password login (scrypt-hashed, `data/users.json`),
  roles (admin/user), admin-only **user CRUD** page. Admin seeded from config.
- ✅ Capability protocol ([`protocol/messages.js`](./protocol/messages.js)):
  `hello` / `action` / `result` / `stream`, device registry + request routing.
- ✅ Two WebSocket paths: `/ws` (viewers, cookie-authed) and `/agent` (agents,
  **per-device token** authed), with a 30 s heartbeat for Cloudflare.
- ✅ **Device provisioning**: admins create a device *access* (id + one-time
  token) in the back office; the agent logs in with its own credential. List,
  rename, enable/disable, rotate token, delete.
- ✅ Dashboard: device list + **GPIO control** (digital switch, PWM/servo slider).
- ⏳ Camera (M2), scripts/shell (M3), pairing + 2FA (M4), mobile agents (M5).

## Run it locally

```bash
npm install
cp config.example.json config.json   # then set password, sessionSecret (admin seeds from these)
npm run build                         # build the client into dist/
npm start                             # server on http://127.0.0.1:16010
```

Dev (hot reload): `npm run dev` serves the client on `:16011` and proxies
`/api`, `/ws`, `/agent` to the backend on `:16010` (run `npm start` too).

Then, as admin, provision a device (Devices -> Add device) to get a one-time
token + agent config. Put it in the `remote_agent` repo config, run the agent,
and the device appears on the dashboard; toggle its light / move its servo.

## Config (`config.json`, gitignored)

| Key | Meaning |
|---|---|
| `server.port` / `server.host` | listen address (default `127.0.0.1:16010`) |
| `server.password` | dashboard login password |
| `server.sessionSecret` | HMAC secret for the session cookie |
| `server.adminUser` | username for the seeded admin (default `admin`) |

Overridable by env: `PORT`, `HOST`, `REMOTE_PASSWORD`, `SESSION_SECRET`.

Device credentials are **not** in config — they are provisioned at runtime from
the back office and stored in `data/devices.json` (gitignored). Tokens are kept
retrievable (not one-way hashed) so an admin can re-reveal / re-send a device’s
config any time; the file lives only on your box. Rotate to invalidate the old one.

## Deploy (later)

Same pattern as `server_monitoring`: pm2 app on `127.0.0.1:16010`, nginx vhost
for `remote.omranisystems.com` with TLS, WSS proxied on 443. Camera (M2) adds a
`coturn` TURN server. Do **not** expose the shell capability before the M4
hardening (pairing, per-device keys, 2FA) — see `ARCHITECTURE.md` §6.

## Security note

v1 uses per-user accounts (admin/user) for the dashboard and per-device tokens
for agents, all behind TLS. Treat raw
shell as off-by-default and gated; prefer allow-listed scripts. The M4 milestone
replaces the shared token with per-device keys and adds 2FA.
