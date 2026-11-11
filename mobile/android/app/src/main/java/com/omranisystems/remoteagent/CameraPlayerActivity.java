package com.omranisystems.remoteagent;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.rtsp.RtspMediaSource;
import androidx.media3.ui.PlayerView;

/**
 * Watch one of the owner's cameras at home (M7b): plays its RTSP stream straight from the camera over the local
 * network (nothing goes through the server). "Sharp" = main stream, "Light" = sub stream when the camera has one.
 * Credentials come from CameraStore and stay on the phone.
 */
public class CameraPlayerActivity extends Activity {
    static final String EXTRA_ID = "camera_id";
    static final String EXTRA_LOW = "low";

    private ExoPlayer player;
    private CameraStore.Cam cam;
    private boolean low;
    private TextView status;
    private Button quality;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        cam = CameraStore.get(this, getIntent().getStringExtra(EXTRA_ID));
        if (cam == null) { finish(); return; }
        low = getIntent().getBooleanExtra(EXTRA_LOW, false);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        PlayerView view = new PlayerView(this);
        view.setUseController(false);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setPadding(32, 24, 32, 24);
        status.setBackgroundColor(0x99000000);
        FrameLayout.LayoutParams top = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP);
        root.addView(status, top);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER);
        bar.setPadding(16, 16, 16, 32);
        quality = new Button(this);
        quality.setVisibility(cam.sub.isEmpty() ? View.GONE : View.VISIBLE);
        quality.setOnClickListener(v -> { low = !low; play(); });
        Button close = new Button(this);
        close.setText("Close");
        close.setOnClickListener(v -> finish());
        bar.addView(quality);
        bar.addView(close);
        root.addView(bar, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        setContentView(root);

        player = new ExoPlayer.Builder(this).build();
        view.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) show("Connecting to " + title() + "…");
                else if (state == Player.STATE_READY) show(title() + (cam.sub.isEmpty() ? "" : low ? " · light" : " · sharp"));
            }
            @Override public void onPlayerError(PlaybackException e) {
                show("Can't play " + title() + ": " + (e.getCause() != null && e.getCause().getMessage() != null
                    ? e.getCause().getMessage() : e.getErrorCodeName()) + ". Are you on the same Wi-Fi as the camera?");
            }
        });
        play();
    }

    private String title() { return cam.name.isEmpty() ? cam.ip : cam.name; }

    private void show(String text) { status.setText(text); }

    private void play() {
        quality.setText(low ? "Sharp" : "Light");
        // TCP: steadier over Wi-Fi than UDP, and passes routers that drop RTP over UDP
        RtspMediaSource source = new RtspMediaSource.Factory().setForceUseRtpTcp(true)
            .createMediaSource(MediaItem.fromUri(cam.playUrl(low)));
        player.setMediaSource(source);
        player.prepare();
        player.setPlayWhenReady(true);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) player.pause();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (player != null) player.play();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (player != null) { player.release(); player = null; }
    }
}
