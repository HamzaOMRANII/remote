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
export function CameraList({ ra, cameras, onChanged, onError }) {
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
        </li>
      ))}
    </ul>
  );
}
