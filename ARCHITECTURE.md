# Remote — Architecture

**Project:** `remote`
**Live host (planned):** https://remote.omranisystems.com
**Repo:** `remote` (keep PRIVATE, same as `server_monitoring`)
**Owner:** homrani555@gmail.com · self-use
**Status:** v0.1 — architecture draft, awaiting go-ahead to build
**Last updated:** 2026-10-27

---

## 1. What this is

A self-hosted platform to reach **devices the user owns** from one private web
dashboard:

- **See** a device's camera live.
- **Act** on a device: flip a GPIO pin (light on/off, servo angle), run a
  pre-defined script, or open a shell.

Every device runs an **agent** that dials out to the backend and advertises what
it can do (its **capabilities**). The dashboard renders the right controls for
whatever each device offers. Scope is strictly the user's own devices and spaces
— this is a remote-access / home-automation tool, not covert surveillance of
other people.

Known constraint carried from the brainstorm: **iOS blocks background camera
access at the OS level** (store or sideloaded, signed any way). The iPhone agent
therefore works only while the app is foreground on screen. Laptop and Android
are the reliable "left-behind" devices. The viewer (dashboard) works in any
browser including the iPhone's.

---

## 2. Design system — inherited, not invented

Remote is part of the Omrani Systems family and **reuses the exact design system
of `server_monitoring` / `it.omranisystems.com`**. Do not introduce a new
palette, fonts, or component language. Lift `server_monitoring/src/client/styles.css`
tokens and class vocabulary wholesale; add only Remote-specific pieces (video
pane, device-capability controls) in the *same* idiom.

### 2.1 Tokens (from `styles.css`)

```
Background   --navy-950 #050B14   --navy-900 #0A1524   --tile #0B0D12
Lines        --navy-line rgba(139,168,196,0.16)
Accent       --petrol #1C6E7A     --petrol-bright #2FD1D9   (primary accent)
Secondary    --gold #C9A24D       --blue #1E8FE1   --it-blue #3B5BDB
Semantic     --ok #2FD1D9   --warn/gold #C9A24D   --crit/danger #EF4444
Text         --ink #EAF0F6   --ink-muted #90A5B9   --ink-dim #5C7186
Fonts        --font-mark 'Sora' (300/600/700)  — headings, wordmark, buttons
             --font-body 'Inter' (400/500/600) — body
             --font-mono 'JetBrains Mono'       — data, labels, terminals
```

Single dark theme by design (navy). Ambient background = two blurred petrol/blue
orbs (`.orb-a`, `.orb-b`) + `.noise` overlay, fixed behind content (`<Background/>`
in `App.jsx`). Glass cards: `border: 1px solid var(--navy-line)`, `border-radius:
20px`, `background: rgba(10,21,36,0.6)`, `backdrop-filter: blur(8px)`.

### 2.2 Reused components / frames

| Remote UI | Reuse from monitoring |
|---|---|
| App shell: ambient bg + sticky blurred topbar + `.wrap` column | `<Background/>`, `.topbar` / `.brand` / `.w-it`+`.w-light` wordmark, `.wrap` |
| Login | `.login-wrap` / `.login-card` pattern |
| **Device list** (one card per device, status + capability controls) | `.srv-grid` + `.card`, `.status` / `.status-live`, `.live-dot` pulse, `.srv-head` / `.card-name` / `.card-meta` |
| **Stat/among controls** (e.g. GPIO toggles, servo sliders) | `.panel`, `.field`, `.toggle`, `.row`, buttons (`button`, `button.secondary`) |
| **Camera view frame** | New video pane styled as `.chart-panel` / `.card`; video on `#05060a` like `.term-mount`; `.live-dot` + `.term-status` bar for stream state |
| **Shell / scripting frame** | `.tabs`/`.tab`, `.actions`, `.action-row`, `.action-btns`, `.out`/`.out-head`/`pre` for script output, `.term-panel`/`.term-status`/`.term-mount` for an xterm terminal, `.logs-view` style for streams |
| **Privileged-action gate** | `Unlock` component pattern: re-enter dashboard password before any privileged op, password kept in memory, re-checked server-side on each run |

### 2.3 New Remote-specific pieces (same idiom)

- **Camera pane:** 16:9 `<video>` inside a `.card`, dark `#05060a` letterbox,
  petrol-bright controls, `.live-dot` when streaming, muted `.term-status`-style
  bar showing resolution / connection (P2P vs TURN relay).
- **Capability control row:** a labelled control per capability on each device
  card — a `.toggle` for a light, a range input (accent `--petrol-bright`) for a
  servo angle, buttons for scripts.
- **Wordmark:** `rem` in accent + `ote` muted, `brand-sub` = "control", matching
  the `mon`/`itoring` treatment.

---

## 3. System architecture

Three parts. Media and control travel on **separate channels**.

```
   AGENTS (devices you own)            BACKEND                     VIEWER
 ┌───────────────────────┐      ┌──────────────────┐      ┌──────────────────┐
 │ Laptop  camera shell   │      │  WSS signaling   │      │  web dashboard   │
 │         media scripts  │◄────►│  auth + registry │◄────►│  (React PWA)     │
 │ RPi 3   camera gpio     │  WS  │  command router  │  WS  │                  │
 │         shell scripts  │      │  audit log       │      │  (any browser,   │
 │ Android camera scripts │      │                  │      │   incl. iPhone)  │
 │ iPhone  camera (fg)    │      │ remote.omrani... │      │                  │
 └───────────────────────┘      └──────────────────┘      └──────────────────┘
         └───────────── camera video: WebRTC, peer-to-peer ──────────────┘
                         (STUN; coturn TURN relay as fallback)
```

- **Control plane** — persistent **WebSocket (WSS)**, agent → backend and
  viewer → backend. Carries capability advertisements, action requests/responses,
  terminal and script I/O, and the wake signal. Low bandwidth, always connected.
- **Media plane** — **WebRTC** peer-to-peer between agent and viewer, set up only
  on demand for camera. STUN handles most NATs; a self-hosted **coturn** relay
  covers networks where P2P fails. Media is DTLS-SRTP encrypted; the TURN relay
  only forwards encrypted packets.
- **Agents dial out only.** No inbound ports on any device — nothing to
  port-scan, works behind any NAT, minimal attack surface. Matches the
  single-box, dial-out posture of `server_monitoring`.

Stack mirrors the monitoring app where possible: **React 19 + Vite** client,
lightweight **Node** backend (add `ws` for WebSocket; monitoring's is a zero-dep
http server). One **Python** agent covers Pi + laptop.

---

## 4. Capability protocol (the contract)

Everything plugs into one message contract. Define it first; every device and
feature depends on it.

### 4.1 Device registration / advertisement

On connect, an agent authenticates (per-device token) and sends what it can do:

```json
{
  "type": "hello",
  "device": { "id": "laptop-hotel", "name": "Hotel laptop", "platform": "linux" },
  "capabilities": [
    { "cap": "camera", "cameras": ["front", "usb-0"] },
    { "cap": "gpio",   "pins": [{ "id": 17, "kind": "digital", "label": "Desk light" },
                                { "id": 18, "kind": "pwm", "label": "Servo" }] },
    { "cap": "scripts", "scripts": [{ "id": "restart-cam", "label": "Restart camera" }] },
    { "cap": "shell",   "enabled": false }
  ]
}
```

The dashboard reads `capabilities` and renders controls. Unknown caps are
ignored, so new capabilities are additive.

### 4.2 Action request / response

Viewer → backend → agent:

```json
{ "type": "action", "reqId": "a1", "device": "rpi-3",
  "cap": "gpio", "do": "set", "args": { "pin": 17, "value": true } }
```

Agent → backend → viewer:

```json
{ "type": "result", "reqId": "a1", "ok": true, "data": { "pin": 17, "value": true } }
```

Streaming actions (terminal output, script logs, camera signaling) use the same
envelope with `type: "stream"` chunks keyed by `reqId`, terminated by a `result`.
Camera uses `cap: "camera"` actions to exchange WebRTC SDP offers/answers and ICE
candidates, after which media flows P2P off the WebSocket.

Every `action` is **audit-logged** server-side (device, cap, do, args, who, when,
outcome) — reusing the monitoring audit approach.

---

## 5. Capabilities in detail

### 5.1 `camera`
- Agent captures via `aiortc` (Py) / native (phones), publishes a WebRTC track.
- On-demand only: idle until the viewer requests; wakes via the control channel.
- Viewer shows it in the camera pane (§2.3). Connection state (P2P/relay) shown
  in the status bar.
- iPhone: foreground-only (OS limit). Laptop/Android/Pi: background OK.

### 5.2 `gpio` (Raspberry Pi)
- `gpiozero`: digital out for a light; `AngularServo`/PWM for a servo angle.
- Controls: `.toggle` (light), range slider (servo). `do: "set"` with pin+value.

### 5.3 `scripts` — the safe default for "run something"
- Named, **allowlisted** scripts that live on the device (not arbitrary input).
- One button per script; output shown in an `.out` panel.
- This is the primary "do things remotely" mechanism, mirroring monitoring's
  scoped **Actions** console.

### 5.4 `shell` — explicit opt-in, off by default
- Interactive terminal: `pty` → WebSocket stream → `xterm.js` in `.term-mount`.
- **`server_monitoring` deliberately dropped the open web terminal** behind a
  safety gate and kept only allowlisted actions. Remote keeps the same stance:
  `shell` is disabled per-device by default, requires the `Unlock` password gate
  every session, is fully audit-logged, and is never exposed on a device until
  the §6 hardening (M4) is in place.

### 5.5 `media`
- Browse / transfer files to and from a device. Later milestone.

---

## 6. Security model (the backbone)

Once shell + GPIO are exposed, a breach means a root shell and control of
physical hardware — not just a camera feed. The auth work **is** the project.

1. **Agents dial out only** — no inbound ports anywhere.
2. **Per-device identity** — each agent paired once, in person (QR / short code),
   with its own token/key; individually revocable.
3. **2FA on the viewer** — the dashboard controls shells and hardware.
4. **Password gate on privileged ops** — reuse monitoring's `Unlock`: re-enter
   the dashboard password before scripts/shell/gpio-write; re-checked server-side
   on every run.
5. **Prefer `scripts` over raw `shell`** — allowlisted actions can't be turned
   into arbitrary damage. Raw shell is explicit opt-in.
6. **Audit-log every action**, physical actions especially.
7. **Transport**: WSS + HTTPS only, behind nginx with TLS (Let's Encrypt), same
   as monitoring. Config secrets in a gitignored `config.json`.

---

## 7. Repo layout (proposed)

```
remote/
  README.md
  ARCHITECTURE.md          ← this file
  config.example.json
  config.json              ← gitignored (secrets, device tokens)
  package.json
  vite.config.js
  src/
    client/                ← React 19 PWA viewer (reuses monitoring styles.css)
      styles.css           ← copied/linked from server_monitoring, + Remote additions
      pages/  (Login, Devices, Camera, Device, Shell, Settings)
      components/ (DeviceCard, CameraPane, Terminal, CapabilityControl, Unlock)
    server/                ← Node backend: WSS signaling, auth, registry, router, audit
    protocol/              ← shared capability message schema (§4)
  agent/                   ← Python agent for Pi + laptop (aiortc, gpiozero, websockets)
  deploy/                  ← install.sh, nginx.template.conf, INSTALL.md (as monitoring)
```

Deploy pattern mirrors `server_monitoring`: pm2 app on `127.0.0.1:<port>`, nginx
vhost `remote.omranisystems.com`, coturn alongside.

---

## 8. Milestones

Build along the spine, then widen. Visual reference blueprint:
https://claude.ai/artifact/JXwsnCcobFmRzHGix8mra2

- **M0 — Foundations.** Repo, DNS, TLS, backend skeleton + topbar/shell reusing
  the monitoring design. Health check responds.
- **M1 — Vertical slice (GPIO light).** ⭐ Define the capability protocol (§4).
  Pi agent advertises `gpio`; dashboard toggles a real light; add servo slider.
- **M2 — Camera streaming.** WebRTC signaling + wake-on-demand; laptop → browser
  across networks; stand up coturn; extend to Pi + Android.
- **M3 — Shell & scripts.** Allowlisted scripts first (with `Unlock` gate +
  audit); interactive terminal as per-device opt-in.
- **M4 — Multi-device & auth hardening.** Pairing, per-device keys/revocation,
  2FA, rate limiting, device registry UI. *Built 2026-10-29:* TOTP 2FA +
  recovery codes (`/account`), one-time QR pairing (`/connect#pair=CODE`,
  agent `--pair CODE`), failure rate limits (login, 2FA, pairing, agent hello),
  sessions bound to the password hash.
- **M5 — Mobile agents.** Android APK (background camera, sideload + self-update);
  iPhone via 3uTools (foreground-only, documented). *Built 2026-10-29 (Android):*
  `mobile/` = Capacitor shell loading `/connect` (web updates reach the app with
  no reinstall) + native `AgentService` foreground service (camera|microphone,
  CPU + Wi-Fi locks) + `RemoteAgent` plugin (start/stop/status/battery
  exemption) + in-app QR scan for pairing. APK: `cd mobile && npm run build:apk`
  -> `public/download/remote-agent.apk` (served at `/download/remote-agent.apk`).
  iPhone stays browser-only (foreground).
- **M6 — Polish & run.** PWA install, reconnection, systemd/pm2 autostart,
  backups, media transfer, offline/online notifications.

---

## 9. Open decisions

- **Host:** VPS vs. the existing box (TURN relay uses real bandwidth).
- **Backend:** extend monitoring's zero-dep Node http server with `ws`, or use a
  small framework. (Leaning: zero-dep + `ws`, to match the family.)
- **Auth model:** single-user (self) keeps it simple, but keep 2FA on the viewer.
- **Camera on Pi 3:** CSI module vs. USB cam; confirm what hardware is on hand.

---

## 10. Change log

- **2026-10-29** — M5 Android agent app built (APK 1.0.0, signed with the H_CHAT key).
- **2026-10-29** — M4 auth hardening built (2FA, QR pairing, rate limits,
  password-bound sessions, self-service password change).
- **2026-10-27** — v0.1 architecture draft created. Design system confirmed as
  inherited from `server_monitoring`. Awaiting go-ahead to build.
