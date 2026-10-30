import { useEffect, useState } from 'react';
import Background from '../components/Background.jsx';
import TopBar from '../components/TopBar.jsx';
import QrCode from '../components/QrCode.jsx';
import AlertsPanel from '../components/AlertsPanel.jsx';
import { api } from '../api.js';

// The signed-in user's own account: change password, turn 2FA on/off, and
// manage recovery codes. Every sensitive change re-asks for the password (and
// a current code once 2FA is on).

function RecoveryCodes({ codes, onDone }) {
  const [msg, setMsg] = useState('');
  const text = codes.join('\n');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setMsg('Copied'); } catch { setMsg('Select and copy manually'); }
    setTimeout(() => setMsg(''), 1600);
  }
  function download() {
    const url = URL.createObjectURL(new Blob([`Remote recovery codes\n\n${text}\n`], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'remote-recovery-codes.txt' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="cap-block">
      <div className="cap-head">Recovery codes — shown once</div>
      <p className="muted rem-sub">Each code signs you in once if you lose your phone. Keep them somewhere safe, away from the phone.</p>
      <div className="out" style={{ marginTop: 10 }}><pre className="recovery-grid">{text}</pre></div>
      <div className="save-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button onClick={copy}>Copy</button>
        <button className="secondary" onClick={download}>Download</button>
        <button className="secondary" onClick={onDone}>I saved them</button>
        {msg && <span className="saved">{msg}</span>}
      </div>
    </div>
  );
}

function PasswordForm() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setErr(''); setOk('');
    if (f.next !== f.again) { setErr('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.changePassword(f.current, f.next);
      setF({ current: '', next: '', again: '' });
      setOk('Password changed. Other sessions are signed out.');
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel form-card">
      <h2>Password</h2>
      <form onSubmit={submit}>
        <div className="row">
          <label className="field"><span>Current password</span>
            <input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
          <label className="field"><span>New password <span className="muted">(10+ characters)</span></span>
            <input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></label>
          <label className="field"><span>Repeat new password</span>
            <input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></label>
        </div>
        <div className="save-row">
          <button type="submit" disabled={busy || !f.current || !f.next}>{busy ? 'Saving…' : 'Change password'}</button>
          {ok && <span className="saved">{ok}</span>}
          {err && <span className="login-err" style={{ minHeight: 0, marginTop: 0 }}>{err}</span>}
        </div>
      </form>
    </section>
  );
}

function TwoFactor({ user, onChanged }) {
  const [step, setStep] = useState('idle'); // idle | setup | codes | manage
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null);  // { secret, uri }
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setPw(''); setCode(''); setErr(''); };
  async function run(fn) {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const start = (e) => { e.preventDefault(); run(async () => { setSetup(await api.twoFactorSetup(pw)); reset(); setStep('setup'); }); };
  const confirm = (e) => { e.preventDefault(); run(async () => { const r = await api.twoFactorEnable(code); setCodes(r.recoveryCodes); reset(); setStep('codes'); onChanged(); }); };
  const regen = () => run(async () => { const r = await api.twoFactorRecovery(pw, code); setCodes(r.recoveryCodes); reset(); setStep('codes'); onChanged(); });
  const disable = () => run(async () => { await api.twoFactorDisable(pw, code); reset(); setStep('idle'); onChanged(); });

  const errLine = err && <span className="login-err" style={{ minHeight: 0, marginTop: 0 }}>{err}</span>;

  return (
    <section className="panel form-card">
      <h2>Two-factor sign-in{' '}
        <span className={`status ${user.twoFactor ? 'status-live' : 'status-planned'}`} style={{ marginLeft: 8 }}>
          {user.twoFactor ? 'on' : 'off'}</span></h2>

      {step === 'codes' && codes ? (
        <RecoveryCodes codes={codes} onDone={() => { setCodes(null); setStep('idle'); }} />
      ) : step === 'setup' && setup ? (
        <div className="totp-setup">
          <div>
            <QrCode text={setup.uri} size={196} label="Authenticator setup QR code" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <p className="rem-sub" style={{ marginTop: 0 }}>1. Scan with an authenticator app (Google Authenticator, Aegis, 1Password, Authy…).</p>
            <p className="muted rem-sub">Can't scan? Enter this key by hand:</p>
            <code className="secret-key">{setup.secret.match(/.{1,4}/g).join(' ')}</code>
            <form onSubmit={confirm} style={{ marginTop: 14 }}>
              <label className="field"><span>2. Enter the 6-digit code it shows</span>
                <input type="text" inputMode="numeric" autoComplete="one-time-code" className="code-input" placeholder="123 456"
                  value={code} onChange={(e) => setCode(e.target.value)} /></label>
              <div className="save-row" style={{ flexWrap: 'wrap' }}>
                <button type="submit" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Turn on 2FA'}</button>
                <button type="button" className="secondary" onClick={() => { setSetup(null); reset(); setStep('idle'); }}>Cancel</button>
                {errLine}
              </div>
            </form>
          </div>
        </div>
      ) : !user.twoFactor ? (
        <form onSubmit={start}>
          <p className="muted rem-sub" style={{ marginTop: 0 }}>
            Ask for a code from your phone after the password. Strongly recommended — this account can open shells and cameras.</p>
          <div className="row">
            <label className="field"><span>Confirm your password</span>
              <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          </div>
          <div className="save-row">
            <button type="submit" disabled={busy || !pw}>{busy ? '…' : 'Set up 2FA'}</button>
            {errLine}
          </div>
        </form>
      ) : step === 'manage' ? (
        <div>
          <div className="row">
            <label className="field"><span>Password</span>
              <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
            <label className="field"><span>Current code</span>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          </div>
          <div className="save-row" style={{ flexWrap: 'wrap' }}>
            <button className="secondary" disabled={busy || !pw || !code} onClick={regen}>New recovery codes</button>
            <button className="secondary" style={{ color: 'var(--crit)' }} disabled={busy || !pw || !code} onClick={disable}>Turn off 2FA</button>
            <button className="secondary" onClick={() => { reset(); setStep('idle'); }}>Cancel</button>
            {errLine}
          </div>
        </div>
      ) : (
        <div>
          <p className="muted rem-sub" style={{ marginTop: 0 }}>
            Sign-in and shell unlock ask for a code from your authenticator app.
            {' '}<b style={{ color: user.recoveryLeft <= 3 ? 'var(--warn)' : 'inherit' }}>{user.recoveryLeft} recovery code{user.recoveryLeft === 1 ? '' : 's'} left.</b></p>
          <button className="secondary" onClick={() => setStep('manage')}>Manage 2FA</button>
        </div>
      )}
    </section>
  );
}

export default function Account({ me }) {
  const [user, setUser] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.account().then((d) => setUser(d.user)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <Background />
      <TopBar me={me} />
      <main className="wrap">
        <div>
          <h1 style={{ fontFamily: 'var(--font-mark)', fontSize: 24, margin: 0 }}>
            Account <span className="h2-sub muted">{me.username}</span>
          </h1>
          <p className="rem-sub" style={{ marginTop: 6 }}>Your password and two-factor sign-in{me.role === 'admin' ? ', and device alerts' : ''}.</p>
        </div>
        {err && <p className="login-err" style={{ minHeight: 0 }}>{err}</p>}
        {user && user.recoveryLeft === 0 && user.twoFactor && (
          <p className="ctl-note err">You have no recovery codes left — generate new ones below.</p>
        )}
        {user ? <><TwoFactor user={user} onChanged={load} /><PasswordForm /></> : !err && <p className="muted">Loading…</p>}
        {me.role === 'admin' && <AlertsPanel />}
      </main>
    </>
  );
}
