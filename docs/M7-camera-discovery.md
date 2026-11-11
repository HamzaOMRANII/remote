# M7 — Camera discovery on my network (architecture, for validation)

Status: **VALIDATED by the owner on 2026-11-11** (decisions in §8). Fits ARCHITECTURE.md: agents dial out only,
features are capabilities, media is WebRTC through the existing coturn.

## 1. Goal

When a Remote agent (the Android app, or the laptop/Pi agent) is on the owner's **trusted network**, it can
**find the cameras** on that network, show what each one offers (open ports, brand/model), let the owner
**watch them at home**, and **relay them to the dashboard** to watch from anywhere.

## 2. Big picture

```
 HOME NETWORK (trusted Wi-Fi)                              INTERNET
 ┌───────────────────────────────────────────┐
 │ IP cameras (RTSP 554/8554, web 80/8080…)  │
 │      ▲ 1. discover (ONVIF + port check)   │
 │      │ 2. RTSP pull (owner's credentials)  │
 │ ┌────┴──────────────────────┐             │      ┌──────────────────────┐     ┌───────────┐
 │ │ RELAY AGENT               │── WSS ─────────────►│ remote.omranisystems │◄───►│ Dashboard │
 │ │ Android app (spare phone) │  control only       │ signaling, registry, │ WSS │ (browser, │
 │ │ or laptop / Pi agent      │                     │ audit (no video, no  │     │  app)     │
 │ │ - discovery               │                     │ camera passwords)    │     └─────▲─────┘
 │ │ - camera passwords (here) │                     └──────────────────────┘           │
 │ │ - RTSP → WebRTC           │═════ WebRTC video (P2P, or via coturn) ════════════════╛
 │ └───────────────────────────┘             │
 └───────────────────────────────────────────┘
 At home, the phone can also play RTSP directly (no server involved).
```

## 3. Components

| Part | Where | New / changed |
|---|---|---|
| **Trusted network** | Android app; laptop/Pi `config.json` | Owner marks the Wi-Fi once (SSID + BSSID; Android needs the location permission to read them). Discovery refuses to run elsewhere. The laptop/Pi agent lists its trusted subnets. |
| **Discovery engine** | Android (Kotlin/Java, `Discovery.java`); Python (`agent/scan.py`, extended) | ONVIF WS-Discovery, port check, optional SSDP; results as a list (§4) |
| **`discovery` capability** | protocol + both agents | Agent advertises `{ cap: "discovery", network: { name, subnet } }` while on a trusted network; actions `scan` (streams results) and `forget` |
| **Camera store** | on the relay agent only | Camera address, stream path, **owner's credentials encrypted at rest** (Android Keystore AES-GCM; laptop `config.json` chmod 600). The server never stores them. |
| **Relayed cameras** | both agents + dashboard | The relay advertises `{ cap: "camera", cameras: [ {id, name, source:"rtsp"} … ] }`; the viewer picks a camera id when it asks for video (see decision D1) |
| **Local view** | Android app | RTSP player (AndroidX Media3, RTSP support) for "watch at home"; the camera's own web page in an in-app view for web ports |
| **Dashboard UI** | web client | Device card → "Network" panel: Scan, results, "Add camera" (credentials form sent once to the agent), cameras appear as tiles |
| **Server** | `src/server` | Routes the new actions; audit log ("scan", "camera added/removed") with **credentials redacted**; no new storage |

## 4. Discovery (what is checked, and how)

1. **Scope:** only the agent's own private subnet (10/8, 172.16/12, 192.168/16; a /24 by default, max /22).
   Never public addresses.
2. **ONVIF WS-Discovery:** one multicast Probe to 239.255.255.250:3702 → cameras answer with their service
   address (XAddrs), and often brand/model. Standard on most IP cameras (Hikvision, Dahua, Reolink, TP-Link
   Tapo, Axis, …).
3. **Port check** on each address: 554, 8554 (RTSP video), 80, 8080, 443 (web page), 8000 (Hikvision SDK),
   37777 (Dahua), 1935 (RTMP). TCP connect only, 400 ms timeout, max 64 at a time: a /24 takes a few seconds.
4. **Optional SSDP/UPnP** (239.255.255.250:1900) for cameras that announce themselves that way.
5. **Result per device:** `{ ip, ports:[…], onvif?: { manufacturer, model, xaddr }, kind: "camera" | "maybe" | "other" }`.
   "camera" = ONVIF answer or RTSP port open; "maybe" = only web/vendor ports.
6. **After the owner enters credentials:** ONVIF `GetProfiles` + `GetStreamUri` give the exact RTSP address
   (main and sub stream); without ONVIF, a short list of common paths per brand is tried **with the owner's
   credentials only**.

## 5. Video paths

| Where the owner is | Path |
|---|---|
| At home, on the phone | Phone ⇄ camera directly over RTSP (nothing leaves the network) |
| Anywhere, dashboard | Camera →RTSP→ relay agent → WebRTC (DTLS-SRTP) → viewer, P2P or via coturn. Laptop/Pi: aiortc (exists in `agent/camera.py`). Android: Media3 decodes to a Surface → WebRTC video source → encoder (1–2 cameras at a time on a phone). The sub-stream (lower resolution) is used by default for remote viewing. |

The camera is opened **only while someone watches** (as today), so bandwidth and phone battery are used only then.

## 6. Security

- **No password guessing**, no default-credential lists, no brute force: only credentials the owner types.
- Discovery only on a trusted network, only private addresses, only when the owner presses **Scan**
  (see decision D3); scans and camera changes are audit-logged.
- Camera credentials stay on the relay device, encrypted; sent once over WSS (TLS) when added from the dashboard,
  never stored or logged by the server.
- Adding/removing a relayed camera from the dashboard goes through the existing password gate.
- Agents still dial out only: no port is opened on the home router.
- Legal note for the owner: scan only networks you own; recording people is regulated.

## 7. Delivery plan (milestones, each tested and released)

| Step | Content | Test |
|---|---|---|
| **M7a** | Protocol + trusted network + discovery in the **Android app**; results in the app and on the dashboard | Simulated cameras on a test network (mediamtx RTSP server + an ONVIF responder), then the owner's Wi-Fi |
| **M7b** | Watch at home in the app (RTSP player, web page view), credentials stored encrypted | Simulated RTSP stream; owner's cameras |
| **M7c** | Relay from the phone to the dashboard (several cameras on one relay device) | End-to-end with a simulated camera; owner from outside the house |
| **M7d** | Same discovery + multi-camera relay in the **laptop/Pi agent** (extends `scan.py`, `camera.py`) | Same simulated cameras; owner's laptop |

## 8. Decisions to validate

- **D1 — How relayed cameras appear:** (A) each camera is its own device with its own token (today's laptop
  relay: no server change, but every camera needs provisioning) **or** (B, recommended) one relay device lists
  several cameras (`cameras: [...]`), the viewer picks one; small server/dashboard change, one pairing for all.
- **D2 — Where camera passwords live:** only on the relay device, encrypted (recommended) **or** on the server
  (lets any relay use them, but the server then holds secrets for your cameras).
- **D3 — When to scan:** only when the owner presses Scan (recommended) **or** automatically on joining the
  trusted Wi-Fi and every N hours (notifies "new camera found").

**Owner's answers (2026-11-11):**
- D1 → **B: one relay device, many cameras.**
- D2 → *not answered*; default = **credentials only on the relay device, encrypted** — confirm with the owner at the start of M7b (credentials are first needed there).
- D3 → **scan only when the owner presses Scan.**
- Architecture and the M7a → M7d order: **validated**. Build in the Remote session (remote_app_session).

