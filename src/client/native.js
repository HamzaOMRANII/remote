// Android app detection + helpers. The Remote Agent APK loads this same web app
// in a WebView and injects window.Capacitor (RemoteAgent + BarcodeScanner
// plugins). In a normal browser none of this exists and everything is a no-op.

export const APK_URL = '/download/remote-agent.apk';

export const isNative = () => !!window.Capacitor?.isNativePlatform?.();
export const plugin = (name) => window.Capacitor?.Plugins?.[name];
export const isAndroidBrowser = () => !isNative() && /Android/i.test(navigator.userAgent);

// "Resume sharing" flag: set when sharing starts in the app, cleared on
// Disconnect — so reopening the app goes straight back to sharing.
const AUTO_KEY = 'remote.agent.autoshare';
export const autoShare = {
  get: () => { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } },
  set: (on) => { try { on ? localStorage.setItem(AUTO_KEY, '1') : localStorage.removeItem(AUTO_KEY); } catch {} },
};
