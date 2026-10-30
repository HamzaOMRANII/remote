// Android app detection + helpers. The Remote Agent APK loads this same web app
// in a WebView and injects window.Capacitor (RemoteAgent + BarcodeScanner
// plugins). In a normal browser none of this exists and everything is a no-op.

import { useEffect, useState } from 'react';

export const APK_URL = '/download/remote-agent.apk';

// The latest published APK, read live from /download/latest.json (never cached).
// The link carries ?v=<version> so Cloudflare / the browser can't hand out an older
// copy they still hold under the plain URL.
let latest = null;
export function useLatestApk() {
  const [info, setInfo] = useState(latest);
  useEffect(() => {
    if (latest) return;
    fetch('/download/latest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && j.version) { latest = { version: j.version, url: `${APK_URL}?v=${j.version}` }; setInfo(latest); } })
      .catch(() => {});
  }, []);
  return info || { version: '', url: APK_URL };
}

export const isNative = () => !!window.Capacitor?.isNativePlatform?.();
export const plugin = (name) => window.Capacitor?.Plugins?.[name];
export const isAndroidBrowser = () => !isNative() && /Android/i.test(navigator.userAgent);
