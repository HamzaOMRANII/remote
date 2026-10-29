import { useState } from 'react';
import Background from '../components/Background.jsx';
import { api } from '../api.js';
import { go } from '../router.js';

// Two steps when the account has 2FA: password -> 6-digit code (or a recovery
// code). The password step only returns a short-lived ticket in that case.
export default function Login() {
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.login(username, pw);
      if (r.needCode) { setTicket(r.ticket); setPw(''); return; }
      go('/')();
    } catch (e2) {
      setErr(e2.status === 429 ? e2.message : 'Incorrect username or password.');
    } finally { setBusy(false); }
  }

  async function submitCode(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.loginCode(ticket, code);
      go(r.usedRecovery ? '/account' : '/')();
    } catch (e2) {
      if (e2.data && e2.data.restart) { setTicket(null); setCode(''); }
      setErr(e2.message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <Background />
      <div className="login-wrap">
        <section className="panel login-card">
          <div className="brand login-brand">
            <span className="w-it">rem</span><span className="w-light">ote</span>
          </div>
          <div className="domain">remote.omranisystems.com</div>
          {!ticket ? (
            <form onSubmit={submit}>
              <input type="text" placeholder="Username" autoFocus autoCapitalize="none"
                autoCorrect="off" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" placeholder="Password" autoComplete="current-password"
                value={pw} onChange={(e) => setPw(e.target.value)} />
              <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <div className="login-err">{err}</div>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <p className="muted rem-sub" style={{ margin: '0 0 12px' }}>
                Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
              <input type="text" placeholder="123 456" autoFocus inputMode="numeric" autoComplete="one-time-code"
                autoCapitalize="none" autoCorrect="off" className="code-input"
                value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="submit" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Verify'}</button>
              <button type="button" className="secondary" style={{ marginTop: 8 }}
                onClick={() => { setTicket(null); setCode(''); setErr(''); }}>Back</button>
              <div className="login-err">{err}</div>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
