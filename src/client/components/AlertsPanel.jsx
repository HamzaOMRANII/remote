import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Admin: email me when a device goes offline (after a wait, so quick reconnects stay
// silent) and when it comes back. Account page.
export default function AlertsPanel() {
  const [a, setA] = useState(null);       // server settings
  const [list, setList] = useState([]);   // provisioned devices
  const [to, setTo] = useState('');
  const [grace, setGrace] = useState(2);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  function apply(s) { setA(s); setTo(s.to.join(', ')); setGrace(s.graceMin); }
  useEffect(() => {
    api.alerts().then((d) => apply(d.alerts)).catch((e) => setErr(e.message));
    api.listDevices().then((d) => setList(d.devices || [])).catch(() => {});
  }, []);

  async function save(patch, msg = 'Saved') {
    setErr(''); setOk(''); setBusy(true);
    try { apply((await api.saveAlerts(patch)).alerts); setOk(msg); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function test() {
    setErr(''); setOk(''); setBusy(true);
    try { await api.saveAlerts({ to }); await api.testAlert(); setOk(`Test email sent to ${to}`); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  function toggleDevice(id, on) {
    const muted = new Set(a.muted);
    if (on) muted.delete(id); else muted.add(id);
    save({ muted: [...muted] });
  }

  if (!a) return err ? <p className="ctl-note err">{err}</p> : null;
  return (
    <section className="panel form-card">
      <h2>Device alerts</h2>
      <p className="muted rem-sub" style={{ marginTop: 0 }}>
        Email when a device goes offline and when it comes back. Short drops (a phone changing network,
        a server restart) are ignored: the email only goes out if it stays away longer than the wait time.</p>
      {!a.smtpReady && (
        <p className="ctl-note err">Email isn't set up on the server yet — run the one-time command from the
          setup notes, then restart Remote.</p>
      )}
      <div className="ctl-row" style={{ margin: '12px 0' }}>
        <span className="ctl-label">Send alerts</span>
        <label className="switch"><input type="checkbox" checked={a.enabled} disabled={busy || !a.smtpReady}
          onChange={(e) => save({ enabled: e.target.checked, to, graceMin: grace }, e.target.checked ? 'Alerts on' : 'Alerts off')} />
          <span className="track" /><span className="knob" /></label>
      </div>
      <div className="row">
        <label className="field"><span>Send to <span className="muted">(comma between addresses)</span></span>
          <input type="text" inputMode="email" autoComplete="email" value={to} onChange={(e) => setTo(e.target.value)}
            placeholder="you@gmail.com" /></label>
        <label className="field"><span>Wait before alerting <span className="muted">(minutes)</span></span>
          <input type="number" min="1" max="120" value={grace} onChange={(e) => setGrace(e.target.value)} /></label>
      </div>
      <div className="save-row" style={{ flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={() => save({ to, graceMin: Number(grace) })}>Save</button>
        <button className="secondary" disabled={busy || !a.smtpReady || !to.trim()} onClick={test}>Send a test email</button>
        {ok && <span className="saved">{ok}</span>}
      </div>
      {err && <p className="ctl-note err">{err}</p>}
      {list.length > 0 && (
        <div className="cap-block">
          <div className="cap-head">Devices to watch</div>
          {list.map((d) => (
            <div key={d.id} className="ctl-row">
              <span className="ctl-label">{d.label || d.id} <span className="muted mono" style={{ fontSize: 11 }}>{d.online ? 'online' : 'offline'}</span></span>
              <label className="switch"><input type="checkbox" checked={!a.muted.includes(d.id)} disabled={busy}
                onChange={(e) => toggleDevice(d.id, e.target.checked)} />
                <span className="track" /><span className="knob" /></label>
            </div>
          ))}
        </div>
      )}
      {a.smtpReady && <p className="muted rem-sub" style={{ marginBottom: 0 }}>Sent from {a.from}.</p>}
    </section>
  );
}
