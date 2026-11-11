import { useState } from 'react';

const WEB_PORTS = [80, 8080, 443];
export const webPortOf = (h) => (h.ports || []).map((p) => p.port).find((p) => WEB_PORTS.includes(p));
export const canAdd = (h) => h.kind === 'camera' || (h.ports || []).some((p) => p.port === 554 || p.port === 8554);

// Add one camera found on the network (M7b): its own username/password are checked against the camera and
// stored encrypted on this phone only.
export function AddCameraForm({ ra, host, onAdded, onCancel }) {
  const [name, setName] = useState([host.manufacturer, host.model].filter(Boolean).join(' ') || '');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const cam = await ra.addCamera({
        ip: host.ip, ports: (host.ports || []).map((p) => p.port), manufacturer: host.manufacturer || '',
        model: host.model || '', onvif: host.onvif || '', name, username, password,
      });
      onAdded(cam);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form className="net-add" onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Camera ${host.ip}`} /></label>
      <label>Camera username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
      <label>Camera password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></label>
      <p className="muted rem-sub" style={{ margin: 0 }}>The camera's own login (from its box or its app). Checked against the camera,
        then kept encrypted on this phone only.</p>
      <div className="action-btns">
        <button disabled={busy}>{busy ? 'Checking the camera…' : 'Add camera'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="ctl-note err">{err}</div>}
    </form>
  );
}

// The cameras saved on this phone: watch (home network), light stream, web page, remove.
export function CameraList({ ra, cameras, share = { sharing: false, cameraRecordings: [] }, onChanged, onError }) {
  if (!cameras.length) return null;
  async function remove(c) {
    if (!window.confirm(`Remove ${c.name} from this phone?`)) return;
    try { await ra.removeCamera({ id: c.id }); onChanged(); } catch (e) { onError(e.message); }
  }
  return (
    <ul className="net-hosts" style={{ marginTop: 10 }}>
      {cameras.map((c) => (
        <li key={c.id} className="net-host camera">
          <div className="net-host-top">
            <span className="net-ip" style={{ fontWeight: 600 }}>{c.name}</span>
            <span className="mono rem-sub">{c.ip}</span>
          </div>
          <div className="ctl-row" style={{ marginTop: 8 }}>
            <span className="ctl-label">Show on dashboard<span className="ctl-pin">watch from anywhere while this phone shares</span></span>
            <label className="switch">
              <input type="checkbox" checked={!!c.relay} aria-label={`Show ${c.name} on the dashboard`}
                onChange={(e) => ra.setCameraRelay({ id: c.id, on: e.target.checked }).then(onChanged).catch((err) => onError(err.message))} />
              <span className="track" /><span className="knob" />
            </label>
          </div>
          <div className="action-btns" style={{ marginTop: 8 }}>
            <button onClick={() => ra.watchCamera({ id: c.id }).catch((e) => onError(e.message))}>Watch</button>
            {c.hasSub && <button className="secondary" onClick={() => ra.watchCamera({ id: c.id, low: true }).catch((e) => onError(e.message))}>Light</button>}
            {c.webPort ? <button className="secondary" onClick={() => ra.openWebPage({ ip: c.ip, port: c.webPort })}>Web page</button> : null}
            <button className="secondary" onClick={() => remove(c)}>Remove</button>
          </div>
          {c.relay && <MotionSettings ra={ra} cam={c} onChanged={onChanged} onError={onError} />}
          {c.relay && (() => {
            const rec = share.cameraRecordings.includes(c.id);
            return (
              <div style={{ marginTop: 8 }}>
                <button className={`rec-btn ${rec ? 'on' : ''}`} disabled={!share.sharing}
                  onClick={() => ra.recordCamera({ id: c.id, on: !rec }).then(onChanged).catch((e) => onError(e.message))}>
                  <span className="rec-dot" />{rec ? 'Stop recording' : 'Record on this phone'}</button>
                <p className="muted rem-sub" style={{ margin: '6px 0 0' }}>
                  {share.sharing
                    ? 'Saved on this phone in Gallery › Movies › Remote, 5-minute parts, no sound. Nothing goes to the server.'
                    : 'Start sharing above to record this camera (the phone records while it relays it).'}
                </p>
              </div>
            );
          })()}
        </li>
      ))}
    </ul>
  );
}

// Motion alerts for one shown camera (M8c): detected on this phone while it shares on the home network; the
// server emails the owner (Account › Alerts on the dashboard must be on). Snapshots only if allowed here.
function MotionSettings({ ra, cam, onChanged, onError }) {
  const set = (patch) => ra.setCameraMotion({ id: cam.id, ...patch }).then(onChanged).catch((e) => onError(e.message));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="ctl-row">
        <span className="ctl-label">Motion alerts<span className="ctl-pin">email when this camera sees movement</span></span>
        <label className="switch">
          <input type="checkbox" checked={!!cam.motion} aria-label={`Motion alerts for ${cam.name}`} onChange={(e) => set({ on: e.target.checked })} />
          <span className="track" /><span className="knob" />
        </label>
      </div>
      {cam.motion && (
        <>
          <div className="seg" role="group" aria-label="Sensitivity" style={{ marginTop: 8 }}>
            {[['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([v, l]) => (
              <button key={v} type="button" className={(cam.motionLevel || 'medium') === v ? 'on' : ''} onClick={() => set({ level: v })}>{l}</button>
            ))}
          </div>
          <div className="ctl-row" style={{ marginTop: 8 }}>
            <span className="ctl-label">Snapshot in the email</span>
            <label className="switch">
              <input type="checkbox" checked={!!cam.motionSnapshot} aria-label={`Snapshot in the email for ${cam.name}`} onChange={(e) => set({ snapshot: e.target.checked })} />
              <span className="track" /><span className="knob" />
            </label>
          </div>
          <p className="muted rem-sub" style={{ margin: '6px 0 0' }}>
            Low: a person close by · High: small movements. Watched on this phone while it shares on your network
            (the camera stream then runs all the time on your Wi-Fi). At most one email every 10 minutes per camera.
            {cam.motionSnapshot
              ? ' The picture goes through the Remote server into your email; the server doesn\'t keep it.'
              : ' No picture leaves the phone.'}
          </p>
        </>
      )}
    </div>
  );
}
