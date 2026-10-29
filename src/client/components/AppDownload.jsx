import { APK_URL, isNative } from '../native.js';

// "Get the Android app" call-to-action. Hidden inside the app itself.
//   variant="card"   panel with the pitch (Devices page)
//   variant="inline" one line (Login / Connect)
export default function AppDownload({ variant = 'inline' }) {
  if (isNative()) return null;
  if (variant === 'card') {
    return (
      <section className="panel app-dl">
        <div className="app-dl-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: '0 0 4px' }}>Remote for Android</h2>
          <p className="muted rem-sub" style={{ margin: 0 }}>
            Manage your devices from your phone, and share the phone's camera live —
            it keeps streaming with the screen off, unlike a browser tab.</p>
        </div>
        <a className="btn" href={APK_URL} download>Download the app</a>
      </section>
    );
  }
  return (
    <p className="muted rem-sub app-dl-inline">
      <a href={APK_URL} download>Get the Android app</a> — dashboard + always-on camera sharing.
    </p>
  );
}
