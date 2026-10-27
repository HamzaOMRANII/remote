import { api } from '../api.js';
import { go } from '../router.js';

// Sticky blurred topbar with the family wordmark: "rem" accent + "ote" muted,
// matching monitoring's "mon"/"itoring" treatment.
export default function TopBar({ connected }) {
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
        <span className="conn" title={connected ? 'Connected' : 'Reconnecting…'}>
          <span className={`live-dot ${connected ? '' : 'off'}`} />
          {connected ? 'live' : 'offline'}
        </span>
        <a href="/login" onClick={signOut}>Sign out</a>
      </nav>
    </header>
  );
}
