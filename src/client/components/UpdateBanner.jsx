import { useEffect, useRef, useState } from 'react';
import { APK_URL, isNative, plugin } from '../native.js';

// Android app only: offers a one-tap update when /download/latest.json has a newer
// version than the installed app. The app downloads the APK, checks its sha256 and
// opens Android's installer (the user confirms there). Checked on start and whenever
// the app comes back to the screen.
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

export default function UpdateBanner() {
  const [upd, setUpd] = useState(null); // { have, latest, sha256 }
  const [progress, setProgress] = useState(-1);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(false);
  const lastCheck = useRef(0);
  const ra = plugin('RemoteAgent');

  async function check() {
    if (!ra || Date.now() - lastCheck.current < 10 * 60 * 1000) return;
    lastCheck.current = Date.now();
    try {
      const [st, j] = await Promise.all([
        ra.status(),
        fetch('/download/latest.json', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (st.version && j.version && newer(j.version, st.version)) setUpd({ have: st.version, latest: j.version, sha256: j.sha256 });
      else setUpd(null);
    } catch {}
  }

  useEffect(() => {
    if (!isNative()) return undefined;
    check();
    const onShow = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function update() {
    setErr('');
    const url = `${location.origin}${APK_URL}?v=${upd.latest}`;
    if (!ra.installUpdate) { // apps older than 1.7.0: let the browser download it
      try { await ra.openUrl({ url }); } catch { location.href = url; }
      return;
    }
    const t = setInterval(async () => {
      try { setProgress((await ra.updateProgress()).progress); } catch {}
    }, 500);
    setProgress(0);
    try { await ra.installUpdate({ url, sha256: upd.sha256 }); }
    catch (e) { setErr(e.message); }
    finally { clearInterval(t); setProgress(-1); }
  }

  if (!upd || hidden) return null;
  const busy = progress >= 0;
  return (
    <div className="update-bar" role="status">
      <div className="update-text">
        <strong>Remote {upd.latest}</strong> is available <span className="muted">· you have {upd.have}</span>
        {busy && <div className="update-progress"><span style={{ width: `${progress}%` }} /></div>}
        {err && <div className="ctl-note err">{err}</div>}
      </div>
      <button onClick={update} disabled={busy}>{busy ? `Downloading ${progress}%` : 'Update'}</button>
      {!busy && <button className="secondary update-later" aria-label="Later" onClick={() => setHidden(true)}>Later</button>}
    </div>
  );
}
