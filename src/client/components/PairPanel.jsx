import { useEffect, useState } from 'react';
import QrCode from './QrCode.jsx';

// One-time pairing for a device: a QR the phone/laptop scans (opens /connect
// with the code), or the same code typed into /connect or passed to the Pi
// agent. Burns on first use, expires after 10 minutes.
export default function PairPanel({ pairing, online, onNew, onClose }) {
  const { device, code, expiresAt } = pairing;
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState('');
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  const expired = left === 0;
  const url = `${location.origin}/connect#pair=${code}`;
  const cmd = `python3 agent/remote_agent.py --pair ${code} --url ${location.origin}`;

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); setMsg(`${what} copied`); } catch { setMsg('Select and copy manually'); }
    setTimeout(() => setMsg(''), 1600);
  }

  return (
    <section className="panel" style={{ borderColor: 'color-mix(in srgb, var(--petrol-bright) 45%, transparent)' }}>
      <h2>Pair {device.label || device.id}</h2>
      {online ? (
        <p className="rem-sub"><span className="live-dot" /> {device.label || device.id} is online. You can close this.</p>
      ) : null}
      <div className="totp-setup">
        <div className={expired ? 'qr-expired' : ''}>
          <QrCode text={url} size={196} label={`Pairing QR code for ${device.label || device.id}`} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <p className="rem-sub" style={{ marginTop: 0 }}>
            <b>Phone / laptop:</b> scan with the camera; it opens the connect page already signed in as this device.
            Or open <code>{location.origin}/connect</code> and type the code.
            {' '}<b>Android, always-on camera:</b> install <a href="/download/remote-agent.apk">Remote Agent</a> and tap <i>Scan pairing QR</i>.</p>
          <div className="pair-code mono">{code}</div>
          <p className="muted rem-sub" style={{ marginTop: 4 }}>
            {expired ? 'Expired.' : `One use · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</p>
          <p className="rem-sub"><b>Raspberry Pi / Linux agent:</b> run in the <code>remote_agent</code> folder:</p>
          <div className="out"><pre>{cmd}</pre></div>
        </div>
      </div>
      <div className="save-row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        {expired
          ? <button onClick={onNew}>New code</button>
          : <button onClick={() => copy(url, 'Link')}>Copy link</button>}
        <button className="secondary" onClick={() => copy(cmd, 'Command')}>Copy agent command</button>
        <button className="secondary" onClick={onClose}>{online ? 'Done' : 'Cancel'}</button>
        {msg && <span className="saved">{msg}</span>}
      </div>
    </section>
  );
}
