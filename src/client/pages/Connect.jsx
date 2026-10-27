import { useEffect, useRef, useState } from 'react';
import Background from '../components/Background.jsx';

// Browser agent — the page you open ON the device. Paste the access (config or
// token), grant camera, and it connects as an agent and streams to the
// dashboard over WebRTC. No install, no command line. Works while the page is
// open (iOS: foreground only).

const LS_KEY = 'remote.agent.cred';

function loadCred() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
}
function saveCred(c) { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch {} }

export default function Connect() {
  const saved = loadCred();
  const [id, setId] = useState(saved?.device?.id || '');
  const [token, setToken] = useState(saved?.token || '');
  const [name, setName] = useState(saved?.device?.name || '');
  const [status, setStatus] = useState('setup'); // setup | connecting | online | error
  const [err, setErr] = useState('');
  const [watchers, setWatchers] = useState(0);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const pcsRef = useRef(new Map());   // viewerId -> RTCPeerConnection
  const iceRef = useRef([{ urls: 'stun:stun.l.google.com:19302' }]);
  const localVideo = useRef(null);
  const retry = useRef(1000);
  const stop = useRef(false);

  // paste the whole config JSON to auto-fill
  function onPaste(text) {
    try {
      const c = JSON.parse(text);
      if (c.token) setToken(c.token);
      if (c.device?.id) setId(c.device.id);
      if (c.device?.name) setName(c.device.name);
    } catch { /* not JSON — ignore, user can fill fields */ }
  }

  async function ensureCamera() {
    if (streamRef.current) return streamRef.current;
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    streamRef.current = s;
    if (localVideo.current) localVideo.current.srcObject = s;
    return s;
  }

  function send(obj) { const ws = wsRef.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  async function onSignal(from, data) {
    let pc = pcsRef.current.get(from);
    try {
      if (data.kind === 'request') {
        const stream = await ensureCamera();
        pc = new RTCPeerConnection({ iceServers: iceRef.current });
        pcsRef.current.set(from, pc);
        setWatchers(pcsRef.current.size);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        pc.onicecandidate = (ev) => { if (ev.candidate) send({ type: 'signal', to: from, data: { kind: 'ice', candidate: ev.candidate } }); };
        pc.onconnectionstatechange = () => {
          if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
            try { pc.close(); } catch {}
            pcsRef.current.delete(from); setWatchers(pcsRef.current.size);
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'signal', to: from, data: { kind: 'offer', sdp: pc.localDescription } });
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
    ws.onopen = () => {
      retry.current = 1000;
      send({ type: 'hello', token: cred.token, device: cred.device, capabilities: [{ cap: 'camera' }] });
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello-ok') setStatus('online');
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

  async function go(e) {
    e.preventDefault();
    setErr('');
    if (!id.trim() || !token.trim()) { setErr('Enter the device id and access token.'); return; }
    const cred = { token: token.trim(), device: { id: id.trim(), name: name.trim() || id.trim(), platform: 'browser' } };
    const savedServer = loadCred()?.server;
    if (savedServer) cred.server = savedServer;
    saveCred(cred);
    setStatus('connecting');
    try {
      const r = await fetch('/api/ice'); if (r.ok) iceRef.current = (await r.json()).iceServers || iceRef.current;
    } catch {}
    try { await ensureCamera(); } catch (e2) { setErr('Camera permission needed: ' + e2.message); setStatus('error'); return; }
    stop.current = false;
    connect(cred);
  }

  function disconnect() {
    stop.current = true;
    try { wsRef.current?.close(); } catch {}
    for (const pc of pcsRef.current.values()) { try { pc.close(); } catch {} }
    pcsRef.current.clear(); setWatchers(0);
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    setStatus('setup');
  }

  useEffect(() => () => { stop.current = true; try { wsRef.current?.close(); } catch {} }, []);

  return (
    <>
      <Background />
      <div className="login-wrap" style={{ minHeight: 'auto', paddingTop: 48 }}>
        <section className="panel" style={{ width: 'min(460px, 100%)' }}>
          <div className="brand login-brand" style={{ textAlign: 'center' }}>
            <span className="w-it">rem</span><span className="w-light">ote</span>
            <span className="brand-sub">device</span>
          </div>
          <div className="domain" style={{ textAlign: 'center', marginBottom: 18 }}>connect this device</div>

          {status === 'setup' || status === 'error' ? (
            <form onSubmit={go}>
              <label className="field"><span>Paste the device config (optional — fills the fields)</span>
                <textarea rows={4} placeholder='{ "token": "…", "device": { "id": "…" } }'
                  onChange={(e) => onPaste(e.target.value)}
                  style={{ width: '100%', background: 'var(--tile)', color: 'var(--ink)', border: '1px solid var(--navy-line)', borderRadius: 10, fontFamily: 'var(--font-mono)', fontSize: 12, padding: 10 }} />
              </label>
              <label className="field"><span>Device id</span>
                <input type="text" value={id} autoCapitalize="none" autoCorrect="off" onChange={(e) => setId(e.target.value)} /></label>
              <label className="field"><span>Access token</span>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
              <button type="submit" style={{ width: '100%' }}>Connect & share camera</button>
              {err && <div className="login-err">{err}</div>}
            </form>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="conn" style={{ justifyContent: 'center' }}>
                <span className={`live-dot ${status === 'online' ? '' : 'off'}`} />
                {status === 'online' ? `online${watchers ? ` · ${watchers} watching` : ''}` : 'connecting…'}
              </div>
              <div className="cam-pane">
                <video ref={localVideo} autoPlay playsInline muted />
                <span className="cam-badge"><span className="live-dot" />this device</span>
              </div>
              <p className="muted rem-sub" style={{ textAlign: 'center', margin: 0 }}>
                Keep this page open. Your camera streams to the dashboard on request.
              </p>
              <button className="secondary" onClick={disconnect}>Disconnect</button>
              {err && <div className="ctl-note err" style={{ textAlign: 'center' }}>{err}</div>}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
