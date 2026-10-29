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
    static final String PREFS = "remote_agent";

    static volatile boolean active = false;

    private NativeAgent agent;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;
    private String name = "";
    private boolean audio;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

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

        if (agent != null) agent.stop(); // restart with the new settings
        agent = new NativeAgent(this, prefs.getString("server", ""), prefs.getString("token", ""),
            prefs.getString("id", ""), name, prefs.getBoolean("front", false), audio, this::refreshNotification);
        agent.start();
        active = true;
        return START_STICKY;
    }

    private NotificationManager channel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Camera sharing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while this phone shares its camera with Remote");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        return nm;
    }

    private PendingIntent openApp() {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
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
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setColor(0xFF2FD1D9)
            .setContentTitle("Remote · " + who + " shared")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp())
            .addAction(0, "Stop sharing", stopPi)
            .build();
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
        if (active) channel().notify(ID, buildNotification());
    }

    private void askToResume() {
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_away)
            .setColor(0xFFC9A24D)
            .setContentTitle("Remote · sharing paused")
            .setContentText("Android stopped the camera. Tap to resume.")
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build();
        channel().notify(ID + 1, n);
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
        if (agent != null) { agent.stop(); agent = null; }
        if (cpu != null && cpu.isHeld()) cpu.release();
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
