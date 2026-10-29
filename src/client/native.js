// Android app detection + helpers. The Remote Agent APK loads this same web app
// in a WebView and injects window.Capacitor (RemoteAgent + BarcodeScanner
// plugins). In a normal browser none of this exists and everything is a no-op.

export const APK_URL = '/download/remote-agent.apk';

export const isNative = () => !!window.Capacitor?.isNativePlatform?.();
export const plugin = (name) => window.Capacitor?.Plugins?.[name];
export const isAndroidBrowser = () => !isNative() && /Android/i.test(navigator.userAgent);
