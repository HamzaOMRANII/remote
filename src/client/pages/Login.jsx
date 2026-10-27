import { useState } from 'react';
import Background from '../components/Background.jsx';
import { api } from '../api.js';
import { go } from '../router.js';

export default function Login() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.login(pw);
      go('/')();
    } catch {
      setErr('Incorrect password.');
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
          <form onSubmit={submit}>
            <input type="password" placeholder="Dashboard password" autoFocus
              value={pw} onChange={(e) => setPw(e.target.value)} />
            <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <div className="login-err">{err}</div>
          </form>
        </section>
      </div>
    </>
  );
}
