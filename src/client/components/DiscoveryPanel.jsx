import { useState } from 'react';
import NetworkHosts, { mergeHost } from './NetworkHosts.jsx';
import { canAdd } from './MyCameras.jsx';

// `discovery` capability (M7): the device (a phone on the owner's Wi-Fi, or the laptop/Pi agent) looks for cameras
// on its network. Results stream in while it scans (a few seconds), then the final list replaces them.
// M9 (laptop/Pi agent, cap.canAdd): "This is my network" once, then Add a camera with only its own username and
// password — the agent finds the stream link itself — and this computer's own cameras are listed too.
function AddForm({ device, host, action, onDone, onCancel }) {
  const [name, setName] = useState([host.manufacturer, host.model].filter(Boolean).join(' '));
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const cam = await action(device, 'discovery', 'add', {
        ip: host.ip, ports: (host.ports || []).map((p) => p.port), manufacturer: host.manufacturer || '',
        model: host.model || '', onvif: host.onvif || '', name, username, password,
      });
      onDone(cam);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form className="net-add" onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Camera ${host.ip}`} /></label>
      <label>Camera username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
      <label>Camera password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></label>
      <p className="muted rem-sub" style={{ margin: 0 }}>The camera's own login (from its box or its app). No stream link needed:
        the computer finds it, checks it, and keeps it on that computer only.</p>
      <div className="action-btns">
        <button disabled={busy}>{busy ? 'Finding the video…' : 'Add camera'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="ctl-note err">{err}</div>}
    </form>
  );
}

export default function DiscoveryPanel({ device, cap, runStream, action }) {
  const [hosts, setHosts] = useState([]);
  const [local, setLocal] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const net = cap.network || {};
  const agent = !!cap.canAdd;               // laptop/Pi agent (M9); the phone adds cameras in its own app
  const trusted = net.trusted !== false;
  const added = cap.added || [];
  const addedIps = new Set(added.map((a) => a.ip));

  async function scan() {
    setScanning(true); setHosts([]); setNote(null); setAdding('');
    try {
      const { done } = runStream(device, 'discovery', 'scan', {}, (host) => {
        if (host && host.ip) setHosts((list) => mergeHost(list, host));
      });
      const data = await done;
      const list = (data && data.hosts) || [];
      setHosts(list);
      if (data && data.local) setLocal(data.local);
      if (data && data.untrusted) { setNote({ ok: false, text: `${data.local ? `${data.local.length} camera(s) on this computer. ` : ''}To scan the network, press "This is my network" first.` }); return; }
      const cams = list.filter((h) => h.kind === 'camera').length;
      const own = data && data.local ? `${data.local.length} on this computer · ` : '';
      setNote({ ok: true, text: `${own}${cams} camera${cams === 1 ? '' : 's'} on the network · ${list.length} device${list.length === 1 ? '' : 's'} with camera ports` });
    } catch (e) {
      setNote({ ok: false, text: e.message });
    } finally { setScanning(false); }
  }

  async function markMine() {
    setBusy(true); setNote(null);
    try {
      const r = await action(device, 'discovery', 'trust', {});
      setNote({ ok: true, text: `${r.network} is now your network. Scan for cameras.` });
    } catch (e) { setNote({ ok: false, text: e.message }); } finally { setBusy(false); }
  }

  async function remove(cam) {
    if (!window.confirm(`Remove ${cam.name} from ${device.name || device.id}?`)) return;
    try { await action(device, 'discovery', 'remove', { id: cam.id }); setNote({ ok: true, text: `${cam.name} removed.` }); }
    catch (e) { setNote({ ok: false, text: e.message }); }
  }

  const hostActions = agent ? (h) => {
    if (addedIps.has(h.ip)) return <div className="ctl-note ok" style={{ marginTop: 8 }}>Added · in the camera list above</div>;
    if (!canAdd(h)) return null;
    if (adding === h.ip) {
      return <AddForm device={device} host={h} action={action} onCancel={() => setAdding('')}
        onDone={(cam) => { setAdding(''); setNote({ ok: true, text: `${cam.name} added: pick it in the camera list above and press Start.` }); }} />;
    }
    return <div className="action-btns" style={{ marginTop: 8 }}><button onClick={() => setAdding(h.ip)}>Add</button></div>;
  } : undefined;

  const localList = local || cap.local || [];

  return (
    <div className="cap-block">
      <div className="cap-head">Cameras{net.name ? ` · ${net.name}` : ''}{net.subnet && net.subnet !== net.name ? <span className="ctl-pin">{net.subnet}</span> : null}</div>
      <p className="muted rem-sub" style={{ margin: '0 0 10px' }}>
        {agent
          ? 'Finds this computer’s cameras (built-in, USB) and the cameras on its network (ONVIF and camera ports). Nothing logs in to a camera until you add it with its own password.'
          : 'Finds the cameras on this device’s network (ONVIF and camera ports). Nothing logs in to them. Add them in the Remote app on this phone.'}
      </p>

      {agent && cap.media === false && (
        <div className="ctl-note err" style={{ marginBottom: 10 }}>
          Video isn't installed on this computer yet. On it, run <span className="mono">pip install aiortc</span>, then restart the agent.
        </div>
      )}

      {agent && !trusted ? (
        <div className="action-btns">
          <button disabled={busy} onClick={markMine}>{busy ? 'Saving…' : 'This is my network'}</button>
          <button className="secondary" disabled={scanning} onClick={scan}>{scanning ? 'Scanning…' : 'Scan this computer only'}</button>
        </div>
      ) : (
        <button className="secondary" disabled={scanning} onClick={scan}>{scanning ? 'Scanning…' : 'Scan for cameras'}</button>
      )}
      {agent && !trusted && <p className="muted rem-sub" style={{ margin: '8px 0 0' }}>
        The network scan only runs on a network you mark as yours (your home or office Wi-Fi, never a public one).</p>}

      {agent && localList.length > 0 && (
        <>
          <div className="cap-head" style={{ marginTop: 14 }}>On this computer</div>
          <ul className="net-hosts">
            {localList.map((c) => (
              <li key={c.id} className="net-host camera">
                <div className="net-host-top"><span className="net-ip">{c.name}</span><span className="net-kind camera">Camera</span></div>
                <div className="ctl-note ok" style={{ marginTop: 6 }}>Ready · in the camera list above</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {agent && added.length > 0 && (
        <>
          <div className="cap-head" style={{ marginTop: 14 }}>Added network cameras</div>
          <ul className="net-hosts">
            {added.map((c) => (
              <li key={c.id} className="net-host camera">
                <div className="net-host-top"><span className="net-ip">{c.name}</span><span className="mono net-ip">{c.ip}</span></div>
                <div className="action-btns" style={{ marginTop: 8 }}><button className="secondary" onClick={() => remove(c)}>Remove</button></div>
              </li>
            ))}
          </ul>
        </>
      )}

      {(scanning || hosts.length > 0) && (
        <>
          {agent && <div className="cap-head" style={{ marginTop: 14 }}>On the network</div>}
          <div style={{ marginTop: agent ? 0 : 12 }}><NetworkHosts hosts={hosts} scanning={scanning} actions={hostActions} /></div>
        </>
      )}
      {note && <div className={`ctl-note ${note.ok ? 'ok' : 'err'}`}>{note.text}</div>}
    </div>
  );
}
