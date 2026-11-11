import { useState } from 'react';
import NetworkHosts, { mergeHost } from './NetworkHosts.jsx';

// `discovery` capability (M7): the device (a phone on the owner's Wi-Fi) looks for cameras on its network.
// Results stream in while it scans (a few seconds), then the final list replaces them.
export default function DiscoveryPanel({ device, cap, runStream }) {
  const [hosts, setHosts] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState(null);
  const net = cap.network || {};

  async function scan() {
    setScanning(true); setHosts([]); setNote(null);
    try {
      const { done } = runStream(device, 'discovery', 'scan', {}, (host) => {
        if (host && host.ip) setHosts((list) => mergeHost(list, host));
      });
      const data = await done;
      const list = (data && data.hosts) || [];
      setHosts(list);
      const cams = list.filter((h) => h.kind === 'camera').length;
      setNote({ ok: true, text: `${cams} camera${cams === 1 ? '' : 's'} · ${list.length} device${list.length === 1 ? '' : 's'} with camera ports` });
    } catch (e) {
      setNote({ ok: false, text: e.message });
    } finally { setScanning(false); }
  }

  return (
    <div className="cap-block">
      <div className="cap-head">Network{net.name ? ` · ${net.name}` : ''}{net.subnet ? <span className="ctl-pin">{net.subnet}</span> : null}</div>
      <p className="muted rem-sub" style={{ margin: '0 0 10px' }}>
        Finds the cameras on this device's network (ONVIF and camera ports). Nothing logs in to them.
      </p>
      <button className="secondary" disabled={scanning} onClick={scan}>{scanning ? 'Scanning…' : 'Scan for cameras'}</button>
      {(scanning || hosts.length > 0 || note) && <div style={{ marginTop: 12 }}><NetworkHosts hosts={hosts} scanning={scanning} /></div>}
      {note && <div className={`ctl-note ${note.ok ? 'ok' : 'err'}`}>{note.text}</div>}
    </div>
  );
}
