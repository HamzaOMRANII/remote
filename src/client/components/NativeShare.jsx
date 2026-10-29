import { useEffect, useState } from 'react';
import { plugin } from '../native.js';

// Android app only: remote control for the native sharing service. The camera,
// WebRTC and the device connection run in the background service (not in this
// page), so sharing continues with the app in the background, closed or
// swiped away — and the dashboard can be used meanwhile.
export default function NativeShare({ cred, onForget }) {
  const ra = plugin('RemoteAgent');
  const [st, setSt] = useState(null); // plugin status()
  const [front, setFront] = useState(false);
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function refresh() {
    try {
      const s = await ra.status();
      setSt(s);
      return s;
    } catch { return null; }
  }

  useEffect(() => {
    refresh().then((s) => { if (s && s.sharing) { setFront(!!s.front); setAudio(!!s.audio); } });
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function share(opts = {}) {
    setBusy(true); setErr('');
    try {
      await ra.share({
        server: cred.server || `wss://${location.host}/agent`,
        token: cred.token, id: cred.device.id, name: cred.device.name || cred.device.id,
        front: opts.front ?? front, audio: opts.audio ?? audio,
      });
      setTimeout(refresh, 600);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { await ra.stop(); } catch {}
    setTimeout(refresh, 400);
    setBusy(false);
  }
  // changing the camera or audio while sharing restarts the service with the new settings
  function change(next) {
    if (next.front !== undefined) setFront(next.front);
    if (next.audio !== undefined) setAudio(next.audio);
    if (st && st.sharing) share(next);
  }
  // full-screen native view of exactly what the dashboard receives
  async function checkCamera() {
    setErr('');
    try { await ra.preview(); } catch (e) { setErr(e.message); }
  }
  async function askBattery() {
    try { await ra.batteryExemption(); } catch {}
    setTimeout(refresh, 4000); // the system dialog returns asynchronously
  }

  const sharing = !!(st && st.sharing);
  const line = !st ? '…'
    : !sharing ? (st.state === 'paused' ? 'Paused by Android — tap Start sharing' : 'Not sharing')
    : st.state === 'online' ? (st.watchers > 0 ? `Live · ${st.watchers} watching` : 'Ready — the camera turns on when someone watches')
    : st.state === 'error' ? (st.error || 'Error')
    : 'Connecting…';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="share-state">
        <span className={`live-dot ${sharing && st.state === 'online' ? '' : 'off'}`} />
        <div>
          <div className="share-name">{cred.device.name || cred.device.id}</div>
          <div className="mono share-line">{line}</div>
        </div>
      </div>

      <div className="cap-block" style={{ marginTop: 0 }}>
        <div className="cap-head">Camera</div>
        <div className="seg" role="group" aria-label="Camera">
          <button type="button" className={!front ? 'on' : ''} onClick={() => change({ front: false })}>Back</button>
          <button type="button" className={front ? 'on' : ''} onClick={() => change({ front: true })}>Front</button>
        </div>
        <div className="ctl-row" style={{ marginTop: 10 }}>
          <span className="ctl-label">Share audio</span>
          <label className="switch"><input type="checkbox" checked={audio} onChange={(e) => change({ audio: e.target.checked })} />
            <span className="track" /><span className="knob" /></label>
        </div>
      </div>

      {sharing ? (
        <>
          <button onClick={checkCamera}>Check camera</button>
          <button className="secondary" disabled={busy} onClick={stop}>Stop sharing</button>
        </>
      ) : <button disabled={busy} onClick={() => share()}>{busy ? 'Starting…' : 'Start sharing'}</button>}

      <p className="muted rem-sub" style={{ margin: 0, textAlign: 'center' }}>
        Keeps streaming with the screen off and when you close the app.
        Stop it here or from the notification.
        {sharing && ' Check camera shows what the dashboard sees.'}</p>

      {st && !st.batteryExempt && (
        <div className="cap-block" style={{ marginTop: 0 }}>
          <div className="cap-head">Battery</div>
          <p className="muted rem-sub" style={{ margin: '0 0 8px' }}>
            Android may cut the connection overnight to save battery. Let Remote run unrestricted:</p>
          <button className="secondary" onClick={askBattery}>Allow background use</button>
        </div>
      )}

      {err && <div className="ctl-note err" style={{ textAlign: 'center' }}>{err}</div>}
      {!sharing && <button type="button" className="secondary" onClick={onForget}>Use a different device access</button>}
    </div>
  );
}
