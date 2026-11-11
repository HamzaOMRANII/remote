import { useEffect, useState } from 'react';
import NetworkHosts, { mergeHost } from './NetworkHosts.jsx';
import { AddCameraForm, CameraList, canAdd, webPortOf } from './MyCameras.jsx';

// The app's "My network" section (M7): mark this Wi-Fi as the owner's network, then find the cameras on it.
// Works without sharing; while sharing, the dashboard can also scan through this phone.
export default function MyNetwork({ ra }) {
  const [net, setNet] = useState(null);
  const [hosts, setHosts] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cameras, setCameras] = useState([]);
  const [adding, setAdding] = useState('');

  const refresh = () => ra.networkStatus().then(setNet).catch(() => {});
  const loadCameras = () => ra.cameras().then((r) => setCameras(r.cameras || [])).catch(() => {});
  useEffect(() => {
    refresh();
    loadCameras();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function trust() {
    setBusy(true); setErr('');
    try { setNet(await ra.trustNetwork()); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function forget() {
    setBusy(true); setErr('');
    try { setNet(await ra.forgetNetwork({ name: net.name })); setHosts([]); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function scan() {
    setScanning(true); setErr(''); setHosts([]);
    const sub = await ra.addListener('networkScan', (h) => setHosts((list) => mergeHost(list, h)));
    try {
      const res = await ra.scanNetwork();
      setHosts(res.hosts || []);
    } catch (e) { setErr(e.message); } finally { sub.remove(); setScanning(false); }
  }

  if (!net) return null;
  return (
    <div className="cap-block" style={{ marginTop: 0 }}>
      <div className="cap-head">My network</div>
      {!net.wifi ? (
        <p className="muted rem-sub" style={{ margin: 0 }}>Connect to your Wi-Fi to find the cameras on it.</p>
      ) : net.trusted ? (
        <>
          <p className="muted rem-sub" style={{ margin: '0 0 10px' }}>
            <b>{net.name}</b> is your network ({net.subnet}). Scanning only runs here, never on other Wi-Fi.</p>
          <div className="action-btns">
            <button disabled={scanning} onClick={scan}>{scanning ? 'Scanning…' : 'Find my cameras'}</button>
            <button className="secondary" disabled={busy || scanning} onClick={forget}>Not my network</button>
          </div>
          <CameraList ra={ra} cameras={cameras} onChanged={loadCameras} onError={setErr} />
          {(scanning || hosts.length > 0) && (
            <div style={{ marginTop: 12 }}>
              <NetworkHosts hosts={hosts} scanning={scanning} actions={(h) => {
                const saved = cameras.some((c) => c.ip === h.ip);
                const web = webPortOf(h);
                if (adding === h.ip) {
                  return <AddCameraForm ra={ra} host={h} onCancel={() => setAdding('')}
                    onAdded={() => { setAdding(''); loadCameras(); }} />;
                }
                return (
                  <div className="action-btns" style={{ marginTop: 8 }}>
                    {canAdd(h) && !saved && <button className="secondary" onClick={() => setAdding(h.ip)}>Add</button>}
                    {saved && <span className="mono rem-sub">saved</span>}
                    {web && <button className="secondary" onClick={() => ra.openWebPage({ ip: h.ip, port: web })}>Web page</button>}
                  </div>
                );
              }} />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted rem-sub" style={{ margin: '0 0 10px' }}>
            {net.name ? <>Connected to <b>{net.name}</b>. </> : 'Connected to Wi-Fi. '}
            Mark it as your network to find your cameras. Android asks for location access: it's the only way an app
            can read the Wi-Fi name. Your location isn't used or sent anywhere.</p>
          <button disabled={busy} onClick={trust}>{busy ? '…' : 'This is my network'}</button>
        </>
      )}
      {err && <div className="ctl-note err">{err}</div>}
    </div>
  );
}
