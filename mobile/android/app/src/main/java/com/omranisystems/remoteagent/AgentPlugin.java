package com.omranisystems.remoteagent;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Called by the /connect page (window.Capacitor.Plugins.RemoteAgent) to keep sharing alive in the background:
 * start() when the device is online, stop() on disconnect. While started, the WebView stays "visible" to
 * Chromium (SharingWebView) so the camera keeps streaming with another app in front. batteryExemption() opens Android's
 * "ignore battery optimisations" prompt so Doze doesn't cut the network overnight.
 */
@CapacitorPlugin(name = "RemoteAgent")
public class AgentPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Intent service = new Intent(getContext(), AgentService.class);
        service.putExtra("name", call.getString("name", ""));
        service.putExtra("audio", Boolean.TRUE.equals(call.getBoolean("audio", false)));
        try {
            ContextCompat.startForegroundService(getContext(), service);
            setKeepVisible(true);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start background sharing: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), AgentService.class));
        setKeepVisible(false);
        call.resolve();
    }

    private void setKeepVisible(boolean on) {
        SharingWebView.keepVisible = on;
        getActivity().runOnUiThread(() -> {
            if (getBridge().getWebView() instanceof SharingWebView) ((SharingWebView) getBridge().getWebView()).refreshVisibility();
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", running());
        r.put("batteryExempt", batteryExempt());
        r.put("version", BuildConfig.VERSION_NAME);
        call.resolve(r);
    }

    @PluginMethod
    public void batteryExemption(PluginCall call) {
        if (!batteryExempt()) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    private boolean batteryExempt() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    @SuppressWarnings("deprecation")
    private boolean running() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        for (ActivityManager.RunningServiceInfo s : am.getRunningServices(Integer.MAX_VALUE)) {
            if (AgentService.class.getName().equals(s.service.getClassName())) return true;
        }
        return false;
    }
}
