import { isNative, useLatestApk } from '../native.js';

// "Get the Android app" call-to-action. Hidden inside the app itself.
//   variant="card"   panel with the pitch (Devices page)
//   variant="inline" one line (Login / Connect)
// 1.6.0 moved to Remote's own signing key: Android won't update an app signed with another key
const UPGRADE = 'Installed Remote before 1.6.0? Uninstall that old app first (new signing key).';

export default function AppDownload({ variant = 'inline' }) {
  const apk = useLatestApk();
  if (isNative()) return null;
  const v = apk.version ? ` ${apk.version}` : '';
  if (variant === 'card') {
    return (
      <section className="panel app-dl">
        <div className="app-dl-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: '0 0 4px' }}>Remote for Android{v && <span className="mono muted" style={{ fontSize: 13, marginLeft: 8 }}>v{apk.version}</span>}</h2>
          <p className="muted rem-sub" style={{ margin: 0 }}>
            Manage your devices from your phone, and share the phone's camera live —
            it keeps streaming with the screen off, unlike a browser tab — and record it on the phone.</p>
          <p className="muted rem-sub" style={{ margin: '6px 0 0', fontSize: 12 }}>{UPGRADE}</p>
        </div>
        <a className="btn" href={apk.url} download>Download{v}</a>
      </section>
    );
  }
  return (
    <p className="muted rem-sub app-dl-inline">
      <a href={apk.url} download>Get the Android app{v}</a> — dashboard + always-on camera sharing.
      <br /><span style={{ fontSize: 12 }}>{UPGRADE}</span>
    </p>
  );
}
