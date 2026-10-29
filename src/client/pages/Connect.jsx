import { useEffect, useRef, useState } from 'react';
import Background from '../components/Background.jsx';
import { api } from '../api.js';
import AppDownload from '../components/AppDownload.jsx';
import { isNative, plugin, isAndroidBrowser, autoShare } from '../native.js';

// Browser agent — the page you open ON the device. Paste the access, choose the
// camera + microphone, grant permission, and it streams to the dashboard over
// WebRTC. No install, no command line. Works while the page is open (iOS:
// foreground only).
//
// Pairing: scanning the dashboard's QR opens /connect#pair=CODE; the code is
// claimed once for this device's credentials (the fragment never reaches the
// server logs). A code can also be typed in.
//
// Android app (M5): the Remote Agent APK loads this same page in a WebView and
// exposes window.Capacitor.Plugins.RemoteAgent (a foreground service that keeps
// camera + network alive with the screen off) and BarcodeScanner (in-app QR).
// In a plain browser those are absent and the page works as before.
//
// Built-in / USB / USB-C / Bluetooth cameras all appear as selectable video
// inputs. IP cameras (RTSP) can't be captured by a browser directly — they need
// a server-side gateway (planned); an MJPEG URL that allows CORS is attempted.

const LS_KEY = 'remote.agent.cred';

async function scanQr() {
  const scanner = plugin('BarcodeScanner');
  if (!scanner) throw new Error('QR scanner not available');
  const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    await scanner.installGoogleBarcodeScannerModule();
    throw new Error('Google Play services is installing the QR scanner — try again in a moment.');
  }
  const { barcodes } = await scanner.scan({ formats: ['QR_CODE'] });
  return barcodes?.[0]?.rawValue || null;
}
const loadCred = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; } };
const saveCred = (c) => { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch {} };

export default function Connect() {
  const saved = loadCred();
  const [id, setId] = useState(saved?.device?.id || '');
  const [token, setToken] = useState(saved?.token || '');
  const [name, setName] = useState(saved?.device?.name || '');
  const [status, setStatus] = useState('setup');      // setup | connecting | online | error
  const [err, setErr] = useState('');
  const [watchers, setWatchers] = useState(0);
  const [pairCode, setPairCode] = useState('');
  const [paired, setPaired] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [bg, setBg] = useState(null); // native only: { running, batteryExempt, version }

  // sources
  const [cameras, setCameras] = useState([]);
  const [mics, setMics] = useState([]);
  const [sourceType, setSourceType] = useState('device'); // 'device' | 'ip'
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [ipUrl, setIpUrl] = useState('');

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const pcsRef = useRef(new Map());     // viewerId -> RTCPeerConnection
  const iceRef = useRef([{ urls: 'stun:stun.l.google.com:19302' }]);
  const localVideo = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const retry = useRef(1000);
  const stop = useRef(false);

  function send(obj) { const ws = wsRef.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // ---- media sources ----------------------------------------------------
  async function enumerate() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter((d) => d.kind === 'videoinput');
      const ms = devs.filter((d) => d.kind === 'audioinput');
      setCameras(cams); setMics(ms);
      setCameraId((prev) => prev || (cams[0] && cams[0].deviceId) || '');
      setMicId((prev) => prev || (ms[0] && ms[0].deviceId) || '');
    } catch (e) { setErr('could not list devices: ' + e.message); }
  }

  function stopStream() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  }

  // Build the outgoing MediaStream from the current selections.
  async function acquireStream() {
    stopStream();
    let stream;
    if (sourceType === 'ip') {
      if (!ipUrl.trim()) throw new Error('enter the IP camera stream URL');
      const canvas = canvasRef.current || Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
      canvasRef.current = canvas;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = ipUrl.trim();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('cannot load stream (CORS/format)')); setTimeout(res, 1500); });
      const draw = () => { try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch {} rafRef.current = requestAnimationFrame(draw); };
      draw();
      stream = canvas.captureStream(15); // may throw if the image is cross-origin-tainted
      if (micOn) {
        const a = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true });
        a.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video: cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'environment' },
        audio: micOn ? (micId ? { deviceId: { exact: micId } } : true) : false,
      });
    }
    streamRef.current = stream;
    if (localVideo.current) localVideo.current.srcObject = stream;
    return stream;
  }

  // Push the current stream to all connected watchers (replaceTrack where we can;
  // addTrack otherwise, which triggers renegotiation via onnegotiationneeded).
  function applyToPeers() {
    const stream = streamRef.current;
    const vTrack = stream && stream.getVideoTracks()[0];
    const aTrack = stream && stream.getAudioTracks()[0];
    for (const pc of pcsRef.current.values()) {
      const vSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || pc.getSenders().find((s) => !s.track);
      const aSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (vTrack) { vSender ? vSender.replaceTrack(vTrack) : pc.addTrack(vTrack, stream); }
      if (aTrack) { aSender ? aSender.replaceTrack(aTrack) : pc.addTrack(aTrack, stream); }
      else if (aSender) { aSender.replaceTrack(null); }
    }
  }

  async function changeSources() {
    if (status !== 'online' && status !== 'connecting') return;
    setErr('');
    try { await acquireStream(); applyToPeers(); }
    catch (e) { setErr(e.message); }
  }

  // ---- signaling / peers ------------------------------------------------
  function makeOffer(pc, viewerId) {
    pc.createOffer().then((o) => pc.setLocalDescription(o))
      .then(() => send({ type: 'signal', to: viewerId, data: { kind: 'offer', sdp: pc.localDescription } }))
      .catch((e) => setErr(e.message));
  }

  async function onSignal(from, data) {
    let pc = pcsRef.current.get(from);
    try {
      if (data.kind === 'request') {
        const stream = streamRef.current || await acquireStream();
        pc = new RTCPeerConnection({ iceServers: iceRef.current });
        pcsRef.current.set(from, pc);
        setWatchers(pcsRef.current.size);
        pc.onicecandidate = (ev) => { if (ev.candidate) send({ type: 'signal', to: from, data: { kind: 'ice', candidate: ev.candidate } }); };
        pc.onnegotiationneeded = () => makeOffer(pc, from);
        pc.onconnectionstatechange = () => {
          if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
            try { pc.close(); } catch {}
            pcsRef.current.delete(from); setWatchers(pcsRef.current.size);
          }
        };
        stream.getTracks().forEach((t) => pc.addTrack(t, stream)); // fires onnegotiationneeded -> offer
      } else if (data.kind === 'answer' && pc) {
        await pc.setRemoteDescription(data.sdp);
      } else if (data.kind === 'ice' && pc && data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (e) { setErr(e.message); }
  }

  function connect(cred) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = cred.server || `${scheme}://${location.host}/agent`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => { retry.current = 1000; send({ type: 'hello', token: cred.token, device: cred.device, capabilities: [{ cap: 'camera' }] }); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello-ok') { setStatus('online'); startBackground(cred.device.name); }
      else if (msg.type === 'signal') onSignal(msg.from, msg.data);
    };
    ws.onclose = () => {
      if (stop.current) return;
      setStatus('connecting');
      for (const pc of pcsRef.current.values()) { try { pc.close(); } catch {} }
      pcsRef.current.clear(); setWatchers(0);
      setTimeout(() => connect(cred), retry.current);
      retry.current = Math.min(retry.current * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // ---- Android app: background service ------------------------------------
  async function refreshBg() {
    const ra = plugin('RemoteAgent');
    if (ra) { try { setBg(await ra.status()); } catch {} }
  }
  async function startBackground(deviceName) {
    const ra = plugin('RemoteAgent');
    if (!ra) return;
    try { await ra.start({ name: deviceName || '', audio: micOn }); } catch (e) { setErr(e.message); }
    refreshBg();
  }
  async function askBattery() {
    try { await plugin('RemoteAgent').batteryExemption(); } catch {}
    setTimeout(refreshBg, 4000); // the system dialog returns asynchronously
  }
  async function scanAndClaim() {
    setErr('');
    try {
      const raw = await scanQr();
      if (!raw) return;
      const m = raw.match(/pair=([A-Za-z0-9-]+)/) || raw.match(/^([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})$/);
      if (!m) throw new Error('That QR is not a Remote pairing code.');
      claim(m[1]);
    } catch (e) { setErr(e.message); }
  }

  async function claim(code) {
    setErr('');
    try {
      const r = await api.claimPairing(code);
      const cred = { server: r.server, token: r.token, device: { id: r.device.id, name: r.device.name, platform: 'browser' } };
      saveCred(cred);
      setId(r.device.id); setToken(r.token); setName(r.device.name || r.device.id);
      setPaired(r.device.name || r.device.id); setPairCode('');
    } catch (e) { setErr(e.message); }
  }

  // QR link: /connect#pair=CODE -> claim once, then drop the code from the URL
  useEffect(() => {
    const m = location.hash.match(/pair=([A-Za-z0-9-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    claim(m[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPaste(text) {
    try { const c = JSON.parse(text); if (c.token) setToken(c.token); if (c.device?.id) setId(c.device.id); if (c.device?.name) setName(c.device.name); } catch {}
  }

  async function go(e) {
    e.preventDefault();
    start(id, token, name);
  }

  async function start(id, token, name) {
    setErr('');
    if (!id.trim() || !token.trim()) { setErr('Enter the device id and access token.'); return; }
    const cred = { token: token.trim(), device: { id: id.trim(), name: name.trim() || id.trim(), platform: isNative() ? 'android' : 'browser' } };
    const savedServer = loadCred()?.server; if (savedServer) cred.server = savedServer;
    saveCred(cred); setStatus('connecting');
    try { const r = await fetch('/api/ice'); if (r.ok) iceRef.current = (await r.json()).iceServers || iceRef.current; } catch {}
    try { await acquireStream(); await enumerate(); }
    catch (e2) { setErr('Camera/permission: ' + e2.message); setStatus('error'); return; }
    stop.current = false; connect(cred);
    if (isNative()) autoShare.set(true);
  }

  // App: reopening it while sharing was on goes straight back to sharing
  useEffect(() => {
    const c = loadCred();
    if (isNative() && autoShare.get() && c?.token && c?.device?.id) start(c.device.id, c.token, c.device.name || '');
    // leaving the page (e.g. to the dashboard) ends the stream, so end the background service too
    const onHide = () => plugin('RemoteAgent')?.stop().catch(() => {});
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openDashboard(e) {
    e.preventDefault();
    if (status === 'online' && !window.confirm('Opening the dashboard stops sharing this camera. Continue?')) return;
    if (status === 'online' || status === 'connecting') { disconnect(); autoShare.set(true); } // resume on next app start
    location.href = '/';
  }

  function disconnect() {
    stop.current = true;
    try { wsRef.current?.close(); } catch {}
    for (const pc of pcsRef.current.values()) { try { pc.close(); } catch {} }
    pcsRef.current.clear(); setWatchers(0);
    stopStream();
    plugin('RemoteAgent')?.stop().catch(() => {});
    autoShare.set(false);
    setBg(null);
    setStatus('setup');
  }

  useEffect(() => { navigator.mediaDevices?.addEventListener?.('devicechange', enumerate); return () => { stop.current = true; try { wsRef.current?.close(); } catch {} stopStream(); navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate); }; }, []);

  // Android app: re-type the service (camera, or camera + microphone) when audio is toggled
  useEffect(() => { if (status === 'online') startBackground(name || id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn]);

  const liveView = status === 'online' || status === 'connecting';

  return (
    <>
      <Background />
      <div className="login-wrap" style={{ minHeight: 'auto', paddingTop: 48, paddingBottom: 48 }}>
        <section className="panel" style={{ width: 'min(480px, 100%)' }}>
          <div className="brand login-brand" style={{ textAlign: 'center' }}>
            <span className="w-it">rem</span><span className="w-light">ote</span><span className="brand-sub">device</span>
          </div>
          <div className="domain" style={{ textAlign: 'center', marginBottom: 18 }}>connect this device</div>

          {!liveView ? (
            <form onSubmit={go}>
              {paired ? (
                <p className="rem-sub" style={{ textAlign: 'center' }}><span className="live-dot" /> Paired as <b>{paired}</b>. Tap below to start sharing.</p>
              ) : !(id && token) && (
                <>
                  <label className="field"><span>Pairing code (from the dashboard → Pair)</span>
                    <input type="text" placeholder="ABCD-EFGH" autoCapitalize="characters" autoCorrect="off" className="code-input"
                      value={pairCode} onChange={(e) => setPairCode(e.target.value)} /></label>
                  <button type="button" style={{ width: '100%', marginBottom: 14 }} disabled={!pairCode.trim()}
                    onClick={() => claim(pairCode)}>Pair this device</button>
                  {isNative() && (
                    <button type="button" className="secondary" style={{ width: '100%', marginBottom: 14 }}
                      onClick={scanAndClaim}>Scan pairing QR</button>
                  )}
                </>
              )}
              {(id && token) || showManual ? null : (
                <button type="button" className="secondary" style={{ width: '100%', marginBottom: 14 }}
                  onClick={() => setShowManual(true)}>Use a token instead</button>
              )}
              {(((id && token) && !paired) || showManual) && <>
              <label className="field"><span>Paste the device config (optional — fills the fields)</span>
                <textarea rows={3} placeholder='{ "token": "…", "device": { "id": "…" } }' onChange={(e) => onPaste(e.target.value)}
                  style={{ width: '100%', background: 'var(--tile)', color: 'var(--ink)', border: '1px solid var(--navy-line)', borderRadius: 10, fontFamily: 'var(--font-mono)', fontSize: 12, padding: 10 }} />
              </label>
              <label className="field"><span>Device id</span>
                <input type="text" value={id} autoCapitalize="none" autoCorrect="off" onChange={(e) => setId(e.target.value)} /></label>
              <label className="field"><span>Access token</span>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
              </>}
              {((id && token) || showManual) && <button type="submit" style={{ width: '100%' }}>Connect &amp; share</button>}
              {err && <div className="login-err">{err}</div>}
              {isAndroidBrowser() && (
                <p className="muted rem-sub" style={{ textAlign: 'center', marginTop: 14, marginBottom: 0 }}>
                  In a browser the camera stops when the screen turns off.</p>
              )}
              <div style={{ textAlign: 'center', marginTop: 10 }}><AppDownload /></div>
            </form>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="conn" style={{ justifyContent: 'center' }}>
                <span className={`live-dot ${status === 'online' ? '' : 'off'}`} />
                {status === 'online' ? `online${watchers ? ` · ${watchers} watching` : ''}` : 'connecting…'}
              </div>
              <div className="cam-pane"><video ref={localVideo} autoPlay playsInline muted /><span className="cam-badge"><span className="live-dot" />this device</span></div>

              {/* source controls */}
              <div className="cap-block" style={{ marginTop: 0 }}>
                <div className="cap-head">Video source</div>
                <label className="field"><span>Type</span>
                  <select value={sourceType} onChange={(e) => { setSourceType(e.target.value); }}>
                    <option value="device">Camera (built-in / USB / USB-C / Bluetooth)</option>
                    <option value="ip">IP camera (MJPEG URL — experimental)</option>
                  </select></label>

                {sourceType === 'device' ? (
                  <label className="field"><span>Camera</span>
                    <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                      {cameras.length === 0 && <option value="">(no cameras found)</option>}
                      {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
                    </select></label>
                ) : (
                  <label className="field"><span>Stream URL (MJPEG, CORS-enabled)</span>
                    <input type="text" placeholder="http://192.168.1.50/video.mjpg" value={ipUrl} onChange={(e) => setIpUrl(e.target.value)} /></label>
                )}

                <div className="cap-head" style={{ marginTop: 6 }}>Microphone</div>
                <div className="ctl-row">
                  <span className="ctl-label">Share audio</span>
                  <label className="switch"><input type="checkbox" checked={micOn} onChange={(e) => setMicOn(e.target.checked)} /><span className="track" /><span className="knob" /></label>
                </div>
                {micOn && (
                  <label className="field"><span>Microphone</span>
                    <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                      {mics.length === 0 && <option value="">(default)</option>}
                      {mics.map((m, i) => <option key={m.deviceId} value={m.deviceId}>{m.label || `Mic ${i + 1}`}</option>)}
                    </select></label>
                )}

                <div className="action-btns" style={{ marginTop: 4 }}>
                  <button className="secondary" onClick={changeSources}>Apply sources</button>
                  <button className="secondary" onClick={enumerate}>Refresh list</button>
                </div>
                {sourceType === 'ip' && <p className="muted rem-sub" style={{ marginTop: 8 }}>
                  RTSP IP cameras need a server-side gateway (planned). Only MJPEG/HTTP streams that send CORS headers work in-browser.</p>}
              </div>

              {bg && (
                <div className="cap-block" style={{ marginTop: 0 }}>
                  <div className="cap-head">Background</div>
                  <div className="ctl-row">
                    <span className="ctl-label">Keeps streaming with the screen off</span>
                    <span className={`status ${bg.running ? 'status-live' : 'status-planned'}`}>{bg.running ? 'on' : 'off'}</span>
                  </div>
                  {!bg.batteryExempt && (
                    <>
                      <p className="muted rem-sub" style={{ margin: '6px 0 8px' }}>
                        Android may cut the connection overnight to save battery. Allow Remote Agent to run unrestricted:</p>
                      <button className="secondary" onClick={askBattery}>Allow background use</button>
                    </>
                  )}
                </div>
              )}
              <button className="secondary" onClick={disconnect}>Disconnect</button>
              {err && <div className="ctl-note err" style={{ textAlign: 'center' }}>{err}</div>}
            </div>
          )}
          <p className="rem-sub" style={{ textAlign: 'center', margin: '18px 0 0' }}>
            <a href="/" onClick={openDashboard}>Open the dashboard →</a></p>
        </section>
      </div>
    </>
  );
}
