import { api } from '../api.js';
import { go } from '../router.js';
import { usePath } from '../router.js';

// Sticky blurred topbar with the family wordmark ("rem" accent + "ote" muted).
// Shows nav (Users link for admins), the current user, and — on the Devices
// page — the live-connection dot.
export default function TopBar({ me, connected }) {
  const path = usePath();
  async function signOut(e) {
    e.preventDefault();
    try { await api.logout(); } catch {}
    go('/login')();
  }
  return (
    <header className="topbar">
      <div className="brand">
        <span className="w-it">rem</span><span className="w-light">ote</span>
        <span className="brand-sub">control</span>
      </div>
      <nav>
        <a href="/" className={path === '/' ? 'active' : ''} onClick={go('/')}>Devices</a>
        {me && me.role === 'admin' && (
          <a href="/users" className={path === '/users' ? 'active' : ''} onClick={go('/users')}>Users</a>
        )}
        {connected !== undefined && (
          <span className="conn" title={connected ? 'Connected' : 'Reconnecting…'}>
            <span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'live' : 'offline'}
          </span>
        )}
        {me && <span className="brand-sub" title={`Signed in as ${me.username}`}>{me.username}</span>}
        <a href="/login" onClick={signOut}>Sign out</a>
      </nav>
    </header>
  );
}
