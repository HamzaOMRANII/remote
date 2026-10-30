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
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.List;

/**
 * Remote control for AgentService, called by the /connect page (window.Capacitor.Plugins.RemoteAgent):
 *   share({server, token, id, name, front, audio})  asks for permissions, then streams natively in the background
 *   stop()                                           ends sharing
 *   setCamera({front})                               switches camera in place while sharing
 *   preview()                                        full-screen live view of what the dashboard sees
 *   status()                                         { sharing, state, watchers, error, front, audio, batteryExempt, version,
 *                                                      recording, recordingSince, recordingAudio }
 *   batteryExemption()                               Android's "ignore battery optimisations" prompt
 *   startRecording() / stopRecording()               save what is shared as MP4 on this phone (gallery, Movies/Remote)
 *   recordings()                                     { items:[{ id, name, started, duration, size, part, link, exists }] }
 *   playRecording({id}) / shareRecording({id})       open in a video player / Android share sheet (Drive, WhatsApp…)
 *   setRecordingLink({id, link})                     remember where the user put it in the cloud
 *   deleteRecording({id})                            { removed: true | false (left in the gallery) }
 *   openUrl({url})                                   opens a saved cloud link in the browser / Drive app
 *   installUpdate({url, sha256})                     downloads the new APK, checks it, opens Android's installer
 *   updateProgress()                                 { progress: -1 idle | 0-100 downloading }
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
        Recorder rec = NativeAgent.RECORDER;
        r.put("recording", rec != null);
        r.put("recordingSince", rec != null ? rec.since : 0);
        r.put("recordingAudio", rec != null && rec.audio);
        call.resolve(r);
    }

    // ---- recordings -------------------------------------------------------------------------------------------

    @PluginMethod
    public void startRecording(PluginCall call) {
        AgentService.startRecording(err -> {
            if (err == null) call.resolve(); else call.reject(err);
        });
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        NativeAgent.stopRecording(null);
        call.resolve();
    }

    @PluginMethod
    public void recordings(PluginCall call) {
        JSObject r = new JSObject();
        try { r.put("items", new com.getcapacitor.JSArray(Recordings.list(getContext()).toString())); }
        catch (JSONException e) { call.reject(e.getMessage()); return; }
        call.resolve(r);
    }

    private JSONObject recording(PluginCall call) {
        String id = call.getString("id", "");
        JSONObject it = Recordings.find(getContext(), id);
        if (it == null) call.reject("This recording is no longer on the phone.");
        return it;
    }

    @PluginMethod
    public void playRecording(PluginCall call) {
        JSONObject it = recording(call);
        if (it == null) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(Recordings.shareUri(getContext(), it), "video/mp4")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No video player found on this phone.");
        }
    }

    @PluginMethod
    public void shareRecording(PluginCall call) {
        JSONObject it = recording(call);
        if (it == null) return;
        try {
            Intent send = new Intent(Intent.ACTION_SEND).setType("video/mp4")
                .putExtra(Intent.EXTRA_STREAM, Recordings.shareUri(getContext(), it))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(send, "Save or share the recording"));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not share: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setRecordingLink(PluginCall call) {
        Recordings.setLink(getContext(), call.getString("id", ""), call.getString("link", ""));
        call.resolve();
    }

    @PluginMethod
    public void deleteRecording(PluginCall call) {
        JSObject r = new JSObject();
        r.put("removed", Recordings.delete(getContext(), call.getString("id", "")));
        call.resolve(r);
    }

    // ---- self-update ------------------------------------------------------------------------------------------

    private static volatile int updateProgress = -1;

    @PluginMethod
    public void updateProgress(PluginCall call) {
        JSObject r = new JSObject();
        r.put("progress", updateProgress);
        call.resolve(r);
    }

    /** Android always asks the user to confirm; the first time it also asks to allow installs from Remote. */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String sha = call.getString("sha256", "").toLowerCase(java.util.Locale.US);
        if (!url.startsWith("https://")) { call.reject("Bad update link."); return; }
        if (updateProgress >= 0) { call.reject("The update is already downloading."); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(i);
            call.reject("Allow \"Install unknown apps\" for Remote, come back, then tap Update again.", "permission");
            return;
        }
        updateProgress = 0;
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), "updates");
            File apk = new File(dir, "remote-update.apk");
            try {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                okhttp3.OkHttpClient http = new okhttp3.OkHttpClient();
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (okhttp3.Response r = http.newCall(new okhttp3.Request.Builder().url(url).build()).execute()) {
                    if (!r.isSuccessful() || r.body() == null) throw new Exception("download failed (" + r.code() + ")");
                    long total = r.body().contentLength();
                    try (InputStream in = r.body().byteStream(); FileOutputStream out = new FileOutputStream(apk)) {
                        byte[] buf = new byte[64 * 1024];
                        long done = 0;
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            md.update(buf, 0, n);
                            done += n;
                            if (total > 0) updateProgress = (int) Math.min(99, done * 100 / total);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format("%02x", b));
                if (!sha.isEmpty() && !sha.contentEquals(hex)) throw new Exception("the download is damaged, try again");
                Uri uri = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                call.resolve();
            } catch (Throwable t) {
                //noinspection ResultOfMethodCallIgnored
                apk.delete();
                call.reject("Update failed: " + t.getMessage());
            } finally {
                updateProgress = -1;
            }
        }, "RemoteUpdate").start();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) { call.reject("Not a web link."); return; }
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can open this link.");
        }
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
