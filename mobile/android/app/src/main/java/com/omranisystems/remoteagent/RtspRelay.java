package com.omranisystems.remoteagent;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.Surface;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.rtsp.RtspMediaSource;
import org.webrtc.EglBase;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

/**
 * Relays one of the owner's cameras to the dashboard (M7c): the phone at home plays the camera's RTSP stream
 * (Media3, decoded into a SurfaceTexture) and feeds the frames to a WebRTC video track, which NativeAgent sends to
 * each viewer like the phone's own camera. One relay per camera, shared by all its viewers; it runs only while
 * someone watches. The sub stream is used when the camera has one (less upload from home).
 */
final class RtspRelay {
    private static final String TAG = "RemoteRelay";

    interface Failure { void onFailed(String message); }

    final String cameraId;
    private final HandlerThread thread;
    private final Handler handler;
    private final SurfaceTextureHelper textures;
    private final VideoSource source;
    private final VideoTrack track;
    private final Surface surface;
    private ExoPlayer player; // only touched on `handler`
    private volatile boolean stopped;

    RtspRelay(Context ctx, EglBase.Context egl, PeerConnectionFactory factory, CameraStore.Cam cam, Failure onFailure) {
        cameraId = cam.id;
        thread = new HandlerThread("relay-" + cam.id);
        thread.start();
        handler = new Handler(thread.getLooper());

        textures = SurfaceTextureHelper.create("relay-frames-" + cam.id, egl);
        textures.setTextureSize(1280, 720); // corrected as soon as the stream says its real size
        source = factory.createVideoSource(false);
        source.getCapturerObserver().onCapturerStarted(true);
        textures.startListening(frame -> source.getCapturerObserver().onFrameCaptured(frame));
        surface = new Surface(textures.getSurfaceTexture());
        track = factory.createVideoTrack("relay-" + cam.id, source);

        String url = cam.playUrl(true); // sub stream if any
        handler.post(() -> {
            if (stopped) return;
            player = new ExoPlayer.Builder(ctx.getApplicationContext()).setLooper(thread.getLooper()).build();
            player.setVolume(0f);
            player.addListener(new Player.Listener() {
                @Override public void onVideoSizeChanged(VideoSize size) {
                    if (size.width > 0 && size.height > 0) textures.setTextureSize(size.width, size.height);
                }
                @Override public void onPlayerError(PlaybackException e) {
                    Log.w(TAG, "camera " + cameraId, e);
                    if (!stopped) onFailure.onFailed("The phone can't reach " + (cam.name.isEmpty() ? cam.ip : cam.name)
                        + " (" + e.getErrorCodeName() + "). Is the phone still on the camera's Wi-Fi?");
                }
            });
            player.setVideoSurface(surface);
            player.setMediaSource(new RtspMediaSource.Factory().setForceUseRtpTcp(true).createMediaSource(MediaItem.fromUri(url)));
            player.prepare();
            player.setPlayWhenReady(true);
        });
    }

    VideoTrack track() { return track; }

    /** Stops playing, then frees the frames and the track. Safe to call twice. */
    void stop() {
        if (stopped) return;
        stopped = true;
        handler.post(() -> {
            try { if (player != null) { player.setVideoSurface(null); player.release(); player = null; } }
            catch (Throwable t) { Log.w(TAG, "player release", t); }
            try {
                textures.stopListening();
                source.getCapturerObserver().onCapturerStopped();
                track.dispose();
                source.dispose();
                surface.release();
                textures.dispose();
            } catch (Throwable t) { Log.w(TAG, "relay release", t); }
            thread.quitSafely();
        });
    }
}
