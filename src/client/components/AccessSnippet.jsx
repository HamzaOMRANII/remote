import { useState } from 'react';

// The device's access: its token plus a ready-to-paste agent config.json.
// Can be re-revealed any time from the device card. Copy / Share / Download to
// get it onto the device.
export default function AccessSnippet({ device, token, onDone }) {
  const [msg, setMsg] = useState('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 1600); };

  const snippet = JSON.stringify({
    server: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/agent`,
    token,
    device: { id: device.id, name: device.label || device.id, platform: 'linux' },
    gpio: { pins: [] },
  }, null, 2);

  async function copy() {
    try { await navigator.clipboard.writeText(snippet); flash('Config copied'); }
    catch { flash('Select the text and copy manually'); }
  }

  function download() {
    try {
      const blob = new Blob([snippet], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${device.id}.config.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash('Downloaded config.json');
    } catch { flash('Download failed'); }
  }

  async function share() {
    const file = new File([snippet], `${device.id}.config.json`, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Remote agent — ${device.label || device.id}` });
      } else if (navigator.share) {
        await navigator.share({ title: `Remote agent — ${device.label || device.id}`, text: snippet });
      } else { copy(); flash('Sharing not supported — copied instead'); }
    } catch { /* user cancelled share — ignore */ }
  }

  return (
    <section className="panel" style={{ borderColor: 'color-mix(in srgb, var(--petrol-bright) 45%, transparent)' }}>
      <h2>Access for {device.label || device.id}</h2>
      <p className="muted rem-sub">Put this config into the device's
        <code> remote_agent/config.json</code>, then run the agent. You can reveal
        it again any time, or rotate the token to invalidate the old one.</p>

      <div className="out" style={{ marginTop: 10 }}>
        <div className="out-head">config.json</div>
        <pre>{snippet}</pre>
      </div>

      <div className="save-row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <button onClick={copy}>Copy</button>
        <button className="secondary" onClick={share}>Share</button>
        <button className="secondary" onClick={download}>Download</button>
        <button className="secondary" onClick={onDone}>Close</button>
        {msg && <span className="saved">{msg}</span>}
      </div>
    </section>
  );
}
