import { useState } from 'react';
import CapabilityControl from './CapabilityControl.jsx';

// One card per provisioned device. Shows identity + online status; when online,
// renders a control block per advertised capability. Admins get a manage row
// (rename, enable/disable, rotate token, delete).
export default function DeviceCard({ device, action, admin, onRename, onToggle, onRotate, onDelete, onReveal }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(device.label || device.name || device.id);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState('');

  const online = device.online;
  const caps = device.capabilities || [];

  async function wrap(key, fn) { setBusy(key); try { await fn(); } finally { setBusy(''); } }

  return (
    <section className="card card-static">
      <div className="srv-head">
        <div>
          {editing ? (
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 220 }} />
          ) : (
            <div className="card-name">{device.label || device.name || device.id}</div>
          )}
          <div className="card-meta">{device.id}{device.tokenPrefix ? ` · token ${device.tokenPrefix}…` : ''}</div>
        </div>
        <span className={`status ${online ? 'status-live' : 'status-planned'}`}>
          {online ? 'online' : device.enabled === false ? 'disabled' : 'offline'}
        </span>
      </div>

      {online && caps.length > 0 ? (
        <div className="dev-caps">
          {caps.map((cap) => <CapabilityControl key={cap.cap} device={device.id} cap={cap} action={action} />)}
        </div>
      ) : (
        <p className="muted rem-sub" style={{ margin: '4px 0 0' }}>
          {device.enabled === false
            ? 'Access disabled — the agent cannot connect.'
            : 'Waiting for the agent to connect with this access.'}
          {device.lastSeenAt && <> Last seen {new Date(device.lastSeenAt).toLocaleString()}.</>}
        </p>
      )}

      {admin && (
        <div className="cap-block" style={{ marginTop: 14 }}>
          <div className="cap-head">Manage</div>
          {confirmDel ? (
            <div className="action-btns">
              <button className="secondary" style={{ color: 'var(--crit)' }} disabled={busy === 'del'}
                onClick={() => wrap('del', () => onDelete(device))}>Confirm delete</button>
              <button className="secondary" onClick={() => setConfirmDel(false)}>Cancel</button>
            </div>
          ) : editing ? (
            <div className="action-btns">
              <button className="secondary" disabled={busy === 'rename'}
                onClick={() => wrap('rename', async () => { await onRename(device, label); setEditing(false); })}>Save name</button>
              <button className="secondary" onClick={() => { setEditing(false); setLabel(device.label || device.id); }}>Cancel</button>
            </div>
          ) : (
            <div className="action-btns">
              <button className="secondary" disabled={busy === 'reveal'}
                onClick={() => wrap('reveal', () => onReveal(device))}>Reveal config</button>
              <button className="secondary" onClick={() => setEditing(true)}>Rename</button>
              <button className="secondary" disabled={busy === 'toggle'}
                onClick={() => wrap('toggle', () => onToggle(device))}>{device.enabled === false ? 'Enable' : 'Disable'}</button>
              <button className="secondary" disabled={busy === 'rotate'}
                onClick={() => wrap('rotate', () => onRotate(device))}>Rotate token</button>
              <button className="secondary" onClick={() => setConfirmDel(true)}>Delete</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
