package com.omranisystems.remoteagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Shares this phone's camera with the dashboard, independently of the app's screen: it runs NativeAgent (WebSocket +
 * WebRTC + camera), so streaming continues with the app in the background, closed, or swiped away. Holds CPU and
 * Wi-Fi locks and shows an ongoing notification with a Stop action.
 *
 * Android only lets a camera service start while the app is on screen, so sharing is started from the app. If the
 * system kills the process, START_STICKY brings us back; when Android then refuses the camera from the background,
 * a notification asks the user to tap to resume.
 */
public class AgentService extends Service {
    static final String CHANNEL = "ra_sharing";
    static final int ID = 5501;
    static final String ACTION_START = "start";
    static final String ACTION_STOP = "stop";
    static final String ACTION_STOP_RECORDING = "stop-recording";
    static final String PREFS = "remote_agent";

    static volatile boolean active = false;
    private static volatile AgentService instance;

    private volatile NativeAgent agent;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;
    private String name = "";
    private boolean audio;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        if (ACTION_STOP_RECORDING.equals(action)) {
            NativeAgent.stopRecording(null);
            return START_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            prefs.edit().putBoolean("sharing", false).apply();
            shutdown();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            prefs.edit()
                .putBoolean("sharing", true)
                .putString("server", intent.getStringExtra("server"))
                .putString("token", intent.getStringExtra("token"))
                .putString("id", intent.getStringExtra("id"))
                .putString("name", intent.getStringExtra("name"))
                .putBoolean("front", intent.getBooleanExtra("front", false))
                .putBoolean("audio", intent.getBooleanExtra("audio", false))
                .apply();
        } else if (!prefs.getBoolean("sharing", false)) {
            stopSelf(); // sticky restart after the user had stopped sharing
            return START_NOT_STICKY;
        }

        name = prefs.getString("name", "");
        audio = prefs.getBoolean("audio", false);
        try {
            goForeground();
        } catch (Exception e) {
            // Restarted by the system while the app is in the background: Android refuses the camera here.
            NativeAgent.state = "error";
            NativeAgent.lastError = "Android paused sharing — open the app to resume.";
            askToResume();
            stopSelf();
            return START_NOT_STICKY;
        }
        holdLocks();

        active = true;
        instance = this;
        // Restart with the new settings — but only once the old agent has fully let go of the camera
        NativeAgent old = agent;
        agent = null;
        Runnable fresh = () -> {
            if (!active) return; // stopped while the old agent was shutting down
            NativeAgent a = new NativeAgent(this, prefs.getString("server", ""), prefs.getString("token", ""),
                prefs.getString("id", ""), name, prefs.getBoolean("front", false), audio, this::refreshNotification);
            agent = a;
            a.start();
        };
        if (old != null) old.stop(fresh); else fresh.run();
        return START_STICKY;
    }

    /** Front/back camera without restarting: the running agent switches in place; the choice is remembered. */
    static void switchCamera(Context ctx, boolean front) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("front", front).apply();
        AgentService s = instance;
        if (s != null && s.agent != null) s.agent.switchCamera(front);
    }

    /** Records what is shared to this phone's gallery; result gets null or an error. */
    static void startRecording(NativeAgent.Result result) {
        AgentService s = instance;
        NativeAgent a = s == null ? null : s.agent;
        if (a == null) { result.onResult("Start sharing first."); return; }
        a.startRecording(result);
    }

    private NotificationManager channel() { return channel(this); }

    private static NotificationManager channel(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Camera sharing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while this phone shares its camera with Remote");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        return nm;
    }

    private PendingIntent openApp() { return openApp(this); }

    private static PendingIntent openApp(Context ctx) {
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        String who = name == null || name.isEmpty() ? "This phone" : name;
        String text;
        switch (NativeAgent.state) {
            case "online": text = NativeAgent.watchers > 0 ? "Live · " + NativeAgent.watchers + " watching" : "Ready · camera off until someone watches"; break;
            case "error": text = NativeAgent.lastError; break;
            default: text = "Connecting…";
        }
        Intent stop = new Intent(this, AgentService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Recorder rec = NativeAgent.RECORDER;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(rec != null ? android.R.drawable.presence_video_busy : android.R.drawable.presence_video_online)
            .setColor(rec != null ? 0xFFE5484D : 0xFF2FD1D9)
            .setContentTitle(rec != null ? "Remote · recording " + who.toLowerCase() : "Remote · " + who + " shared")
            .setContentText(rec != null ? "Saving to this phone · " + text : text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp());
        if (rec != null) {
            // the notification shows the running time of the recording
            Intent stopRec = new Intent(this, AgentService.class).setAction(ACTION_STOP_RECORDING);
            b.setWhen(rec.since).setShowWhen(true).setUsesChronometer(true)
             .addAction(0, "Stop recording", PendingIntent.getService(this, 2, stopRec, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        return b.addAction(0, "Stop sharing", stopPi).build();
    }

    private void goForeground() {
        channel();
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            if (audio) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            try {
                startForeground(ID, n, type);
            } catch (SecurityException e) {
                // e.g. the microphone permission was not granted: keep at least the camera
                startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
            }
        } else {
            startForeground(ID, n);
        }
    }

    private void refreshNotification() {
        try {
            if (active) channel().notify(ID, buildNotification());
        } catch (Throwable ignored) { /* never let a notification update crash the service */ }
    }

    private void askToResume() {
        notifyResume(this, "Remote · sharing paused", "Android stopped the camera. Tap to resume.");
    }

    /** "Tap to resume" — opening the app resumes sharing (MainActivity.onResume). */
    static void notifyResume(Context ctx, String title, String text) {
        try {
            Notification n = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.presence_video_away)
                .setColor(0xFFC9A24D)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx))
                .build();
            channel(ctx).notify(ID + 1, n);
        } catch (Throwable ignored) { /* e.g. notifications not allowed */ }
    }

    static void clearResumeNotice(Context ctx) {
        try { channel(ctx).cancel(ID + 1); } catch (Throwable ignored) {}
    }

    private void holdLocks() {
        if (cpu == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "remoteagent:sharing");
            cpu.setReferenceCounted(false);
        }
        if (!cpu.isHeld()) cpu.acquire();
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifi = wm.createWifiLock(mode, "remoteagent:sharing");
            wifi.setReferenceCounted(false);
        }
        if (!wifi.isHeld()) wifi.acquire();
    }

    private void shutdown() {
        active = false;
        if (instance == this) instance = null;
        // finish the recording's file first (keeps the CPU awake until it is written), then stop the agent
        PowerManager.WakeLock keep = cpu;
        cpu = null;
        NativeAgent.stopRecording(() -> { if (keep != null && keep.isHeld()) keep.release(); });
        if (agent != null) { agent.stop(null); agent = null; }
        if (wifi != null && wifi.isHeld()) wifi.release();
    }

    @Override
    public void onDestroy() {
        shutdown();
        super.onDestroy();
    }

    // Swiping the app away no longer stops sharing: the stream lives here, not in the app's screen.

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
