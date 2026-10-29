import { api } from '../api.js';
import { go } from '../router.js';
import { usePath } from '../router.js';
import { APK_URL, isNative } from '../native.js';

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
        <a href="/connect" title="Stream this device's camera to the dashboard">{isNative() ? 'Share this phone' : 'Share this device'}</a>
        {!isNative() && <a href={APK_URL} download title="Android app: dashboard + always-on camera sharing">Get the app</a>}
        {connected !== undefined && (
          <span className="conn" title={connected ? 'Connected' : 'Reconnecting…'}>
            <span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'live' : 'offline'}
          </span>
        )}
        {me && (
          <a href="/account" className={path === '/account' ? 'active' : ''} onClick={go('/account')}
            title={`Signed in as ${me.username}${me.twoFactor ? '' : ' — 2FA is off'}`}>
            {me.username}{me.twoFactor === false && <span className="nav-warn" aria-label="2FA off">!</span>}
          </a>
        )}
        <a href="/login" onClick={signOut}>Sign out</a>
      </nav>
    </header>
  );
}
