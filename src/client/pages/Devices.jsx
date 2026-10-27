import { useEffect, useState } from 'react';
import Background from '../components/Background.jsx';
import TopBar from '../components/TopBar.jsx';
import DeviceCard from '../components/DeviceCard.jsx';
import AccessSnippet from '../components/AccessSnippet.jsx';
import { api } from '../api.js';
import { useRemote } from '../ws.js';

function AddDevice({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await api.createDevice({ id, label });
      setId(''); setLabel(''); setOpen(false);
      onCreated(res); // { device, token }
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  if (!open) return <button onClick={() => setOpen(true)}>Add device</button>;
  return (
    <section className="panel form-card">
      <h2>New device access</h2>
      <p className="muted rem-sub">Name the device. The id is derived from the name (or set your own).
        You'll get a token + config to put on the device — revealable again any time.</p>
      <form onSubmit={submit}>
        <div className="row">
          <label className="field"><span>Device name</span>
            <input type="text" placeholder="Device name" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
          <label className="field"><span>Device id <span className="muted">(optional)</span></span>
            <input type="text" placeholder="auto from name" autoCapitalize="none" autoCorrect="off"
              value={id} onChange={(e) => setId(e.target.value)} /></label>
        </div>
        <div className="save-row">
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create access'}</button>
          <button type="button" className="secondary" onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
          {err && <span className="login-err" style={{ minHeight: 0 }}>{err}</span>}
        </div>
      </form>
    </section>
  );
}

export default function Devices({ me }) {
  const { connected, devices: live, action, sendSignal, onSignal } = useRemote();
  const [provisioned, setProvisioned] = useState(null);
  const [reveal, setReveal] = useState(null); // { device, token } shown once
  const [err, setErr] = useState('');
  const admin = me && me.role === 'admin';

  function load() { api.listDevices().then((d) => setProvisioned(d.devices)).catch((e) => setErr(e.message)); }
  useEffect(load, []);
  // refresh the provisioned list whenever the live set changes (online/offline)
  useEffect(() => { load(); }, [live.map((d) => d.id).join(',')]);

  // merge: provisioned record + live capabilities/online
  const liveById = Object.fromEntries(live.map((d) => [d.id, d]));
  const cards = (provisioned || []).map((p) => {
    const l = liveById[p.id];
    return { ...p, online: !!l, platform: l ? l.platform : undefined, capabilities: l ? l.capabilities : [] };
  });

  async function onRename(d, label) { await api.updateDevice(d.id, { label }); load(); }
  async function onToggle(d) { await api.updateDevice(d.id, { enabled: d.enabled === false }); load(); }
  async function onDelete(d) { await api.deleteDevice(d.id); load(); }
  async function onRotate(d) { const res = await api.rotateDevice(d.id); setReveal(res); load(); }
  async function onReveal(d) { const res = await api.revealDevice(d.id); setReveal(res); }

  return (
    <>
      <Background />
      <TopBar me={me} connected={connected} />
      <main className="wrap">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-mark)', fontSize: 24, margin: 0 }}>
              Devices <span className="h2-sub muted">{cards.filter((c) => c.online).length} / {cards.length} online</span>
            </h1>
            <p className="rem-sub" style={{ marginTop: 6 }}>Provision an access, log in from the device, control it here.</p>
          </div>
          {admin && <AddDevice onCreated={(res) => { setReveal(res); load(); }} />}
        </div>

        {err && <p className="login-err" style={{ minHeight: 0 }}>{err}</p>}
        {reveal && <AccessSnippet device={reveal.device} token={reveal.token} onDone={() => setReveal(null)} />}

        {provisioned === null ? (
          <p className="muted">Loading…</p>
        ) : cards.length === 0 ? (
          <div className="empty-wrap">
            <span className="conn"><span className={`live-dot ${connected ? '' : 'off'}`} />
              {connected ? 'Connected' : 'Connecting…'}</span>
            <h2>No devices yet</h2>
            <p className="muted">{admin ? 'Add a device access above, then log in from the device with it.'
              : 'Ask an admin to provision a device access for you.'}</p>
          </div>
        ) : (
          <div className="srv-grid">
            {cards.map((d) => (
              <DeviceCard key={d.id} device={d} action={action} sendSignal={sendSignal} onSignal={onSignal} admin={admin}
                onRename={onRename} onToggle={onToggle} onRotate={onRotate} onDelete={onDelete} onReveal={onReveal} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
