import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';

// `shell` capability: an admin-only interactive terminal. Gated behind a
// password re-prompt (plus a 2FA code when the user has 2FA); then opens a pty
// session on the device (xterm.js <-> pty).

function Gate({ onOk }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  useEffect(() => { api.me().then((d) => setNeedCode(!!d.twoFactor)).catch(() => {}); }, []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.verifyPassword(pw, code); onOk(); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="cap-block">
      <div className="cap-head">Shell</div>
      <p className="muted rem-sub" style={{ marginBottom: 10 }}>
        Opens a real shell on the device. Re-enter your password{needCode ? ' and a 2FA code' : ''} to continue — every command is logged.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="password" placeholder="Your password" value={pw} onChange={(e) => setPw(e.target.value)}
          style={{ maxWidth: 220 }} />
        {needCode && <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="2FA code"
          value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 130 }} />}
        <button type="submit" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock shell'}</button>
        {err && <span className="login-err" style={{ minHeight: 0 }}>{err}</span>}
      </form>
    </div>
  );
}

function Session({ device, runStream, sendAction }) {
  const mountRef = useRef(null);
  const sidRef = useRef('sh-' + Math.random().toString(36).slice(2));
  const [status, setStatus] = useState('opening');

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13, cursorBlink: true,
      theme: { background: '#05060a', foreground: '#EAF0F6', cursor: '#2FD1D9' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mountRef.current);
    try { fit.fit(); } catch {}

    const sid = sidRef.current;
    const { done } = runStream(device, 'shell', 'open', { sid }, (chunk) => term.write(chunk));
    done.then((d) => { setStatus('closed'); term.write(`\r\n\x1b[90m[session ended${d && typeof d.code === 'number' ? ` · exit ${d.code}` : ''}]\x1b[0m\r\n`); })
        .catch((e) => { setStatus('error'); term.write(`\r\n\x1b[31m[${e.message}]\x1b[0m\r\n`); });
    setStatus('live');

    const onData = term.onData((data) => sendAction(device, 'shell', 'input', { sid, data }));
    const sendSize = () => sendAction(device, 'shell', 'resize', { sid, cols: term.cols, rows: term.rows });
    const onResize = term.onResize(sendSize);
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(mountRef.current);
    setTimeout(sendSize, 300);

    return () => {
      onData.dispose(); onResize.dispose(); ro.disconnect();
      sendAction(device, 'shell', 'close', { sid });
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  return (
    <div className="cap-block">
      <div className="cap-head">Shell · <span className="mono" style={{ textTransform: 'none' }}>{status}</span></div>
      <div className="term-panel">
        <div ref={mountRef} className="term-mount" />
      </div>
    </div>
  );
}

export default function ShellTerminal({ device, runStream, sendAction }) {
  const [unlocked, setUnlocked] = useState(false);
  return unlocked
    ? <Session device={device} runStream={runStream} sendAction={sendAction} />
    : <Gate onOk={() => setUnlocked(true)} />;
}
