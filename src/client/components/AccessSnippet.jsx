import { useState } from 'react';

// Shown once, right after a device access is created or rotated: the device's
// token (never retrievable again) plus a ready-to-paste agent config.json.
export default function AccessSnippet({ device, token, onDone }) {
  const [copied, setCopied] = useState('');

  const snippet = JSON.stringify({
    server: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/agent`,
    token,
    device: { id: device.id, name: device.label || device.id, platform: 'linux' },
    gpio: { pins: [] },
  }, null, 2);

  async function copy(text, which) {
    try { await navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(''), 1500); }
    catch { setCopied('(select and copy manually)'); }
  }

  return (
    <section className="panel" style={{ borderColor: 'color-mix(in srgb, var(--petrol-bright) 45%, transparent)' }}>
      <h2>Access created — copy it now</h2>
      <p className="muted rem-sub">This token is shown only once. Paste the config into the device's
        <code> remote_agent/config.json</code>, then run the agent. It can't be retrieved later — rotate to get a new one.</p>

      <div className="out" style={{ marginTop: 10 }}>
        <div className="out-head">config.json</div>
        <pre>{snippet}</pre>
      </div>

      <div className="save-row" style={{ marginTop: 14 }}>
        <button onClick={() => copy(snippet, 'config')}>Copy config</button>
        <button className="secondary" onClick={() => copy(token, 'token')}>Copy token only</button>
        <button className="secondary" onClick={onDone}>Done</button>
        {copied && <span className="saved">{copied === 'config' ? 'Config copied' : copied === 'token' ? 'Token copied' : copied}</span>}
      </div>
    </section>
  );
}
