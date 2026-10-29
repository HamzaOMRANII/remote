package com.omranisystems.remoteagent;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;

/**
 * Remote control for AgentService, called by the /connect page (window.Capacitor.Plugins.RemoteAgent):
 *   share({server, token, id, name, front, audio})  asks for permissions, then streams natively in the background
 *   stop()                                           ends sharing
 *   setCamera({front})                               switches camera in place while sharing
 *   preview()                                        full-screen live view of what the dashboard sees
 *   status()                                         { sharing, state, watchers, error, front, audio, batteryExempt, version }
 *   batteryExemption()                               Android's "ignore battery optimisations" prompt
 */
@CapacitorPlugin(
    name = "RemoteAgent",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class AgentPlugin extends Plugin {

    @PluginMethod
    public void share(PluginCall call) {
        List<String> need = new ArrayList<>();
        if (getPermissionState("camera") != PermissionState.GRANTED) need.add("camera");
        if (call.getBoolean("audio", false) && getPermissionState("microphone") != PermissionState.GRANTED) need.add("microphone");
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) need.add("notifications");
        if (need.isEmpty()) startSharing(call);
        else requestPermissionForAliases(need.toArray(new String[0]), call, "afterPermissions");
    }

    @PermissionCallback
    private void afterPermissions(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is needed to share this phone.");
            return;
        }
        startSharing(call); // microphone / notifications are optional
    }

    private void startSharing(PluginCall call) {
        boolean audio = call.getBoolean("audio", false) && getPermissionState("microphone") == PermissionState.GRANTED;
        Intent i = new Intent(getContext(), AgentService.class).setAction(AgentService.ACTION_START)
            .putExtra("server", call.getString("server"))
            .putExtra("token", call.getString("token"))
            .putExtra("id", call.getString("id"))
            .putExtra("name", call.getString("name", ""))
            .putExtra("front", call.getBoolean("front", false))
            .putExtra("audio", audio);
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start sharing: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), AgentService.class).setAction(AgentService.ACTION_STOP);
        try { getContext().startService(i); } catch (Exception e) { getContext().stopService(new Intent(getContext(), AgentService.class)); }
        call.resolve();
    }

    /** Front/back camera while sharing, in place (viewers stay connected). */
    @PluginMethod
    public void setCamera(PluginCall call) {
        AgentService.switchCamera(getContext(), Boolean.TRUE.equals(call.getBoolean("front", false)));
        call.resolve();
    }

    /** Opens the full-screen "Check camera" view (only while sharing). */
    @PluginMethod
    public void preview(PluginCall call) {
        if (NativeAgent.current == null) { call.reject("Start sharing first."); return; }
        getActivity().startActivity(new Intent(getContext(), PreviewActivity.class));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        android.content.SharedPreferences p = getContext().getSharedPreferences(AgentService.PREFS, Context.MODE_PRIVATE);
        JSObject r = new JSObject();
        r.put("sharing", AgentService.active);
        r.put("state", AgentService.active ? NativeAgent.state : (p.getBoolean("sharing", false) ? "paused" : "stopped"));
        r.put("watchers", NativeAgent.watchers);
        r.put("error", NativeAgent.lastError);
        r.put("deviceId", p.getString("id", ""));
        r.put("name", p.getString("name", ""));
        r.put("front", p.getBoolean("front", false));
        r.put("audio", p.getBoolean("audio", false));
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
}
