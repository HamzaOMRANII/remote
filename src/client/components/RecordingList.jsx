import { useState } from 'react';

// Android app only: recordings saved on this phone (gallery › Movies/Remote).
// Nothing is uploaded to the server: Share sends a file to Drive / any app, and
// the cloud link the user gets there can be pasted back here to find it again.
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const fmtLen = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function RecordingList({ ra, items, reload, onError }) {
  const [editing, setEditing] = useState(null); // id whose cloud link is being edited
  const [link, setLink] = useState('');

  async function act(fn) {
    onError('');
    try { await fn(); } catch (e) { onError(e.message); }
  }
  async function saveLink(id) {
    const v = link.trim();
    if (v && !/^https?:\/\//i.test(v)) { onError('Paste the full link, starting with https://'); return; }
    await act(() => ra.setRecordingLink({ id, link: v }));
    setEditing(null);
    reload();
  }
  async function remove(r) {
    if (!confirm(`Delete ${r.name} from this phone? A copy you shared to the cloud is not affected.`)) return;
    await act(async () => {
      const res = await ra.deleteRecording({ id: r.id });
      if (!res.removed) onError('Removed from the list. Android kept the file: delete it in Gallery › Movies › Remote.');
    });
    reload();
  }

  if (!items.length) return null;
  return (
    <div className="cap-block" style={{ marginTop: 0 }}>
      <div className="cap-head">Recordings on this phone</div>
      <div className="rec-list">
        {items.map((r) => (
          <div key={r.id} className={`rec-item ${r.exists ? '' : 'gone'}`}>
            <div className="rec-meta">
              <span className="rec-when">{fmtWhen(r.started)}{r.part > 1 ? ` · part ${r.part}` : ''}</span>
              <span className="mono rec-facts">{r.exists ? `${fmtLen(r.duration)} · ${fmtSize(r.size)}` : 'deleted from the gallery'}</span>
            </div>
            <div className="rec-actions">
              {r.exists && <button className="secondary" onClick={() => act(() => ra.playRecording({ id: r.id }))}>Play</button>}
              {r.exists && <button className="secondary" onClick={() => act(() => ra.shareRecording({ id: r.id }))}>Share</button>}
              {r.link
                ? <button className="secondary" onClick={() => act(() => ra.openUrl({ url: r.link }))}>Cloud copy</button>
                : <button className="secondary" onClick={() => { setEditing(r.id); setLink(''); }}>Add link</button>}
              <button className="secondary rec-del" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>Delete</button>
            </div>
            {editing === r.id ? (
              <div className="rec-link-edit">
                <input type="url" inputMode="url" placeholder="https://drive.google.com/…" value={link}
                  onChange={(e) => setLink(e.target.value)} autoFocus />
                <button onClick={() => saveLink(r.id)}>Save</button>
                <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : r.link ? (
              <button type="button" className="rec-link mono" onClick={() => { setEditing(r.id); setLink(r.link); }}
                title="Change the cloud link">{r.link}</button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="muted rem-sub" style={{ margin: '10px 0 0' }}>
        To keep a copy off the phone: Share › Drive (or any cloud app), then copy the file's link there and
        add it here so you can find it again.</p>
    </div>
  );
}
