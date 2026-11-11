package com.omranisystems.remoteagent;

import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;

/**
 * Watches one relayed camera for movement (M8c). Attached to the camera's relay track like a recorder: two
 * frames a second become a 64×36 brightness grid for MotionCore. On motion it calls back with a JPEG snapshot
 * (only when the owner allowed snapshots) — encoded on a separate thread so the video path is never slowed.
 */
final class MotionDetector implements VideoSink {
    private static final String TAG = "RemoteMotion";
    private static final long SAMPLE_MS = 500;

    interface OnMotion { void onMotion(byte[] jpegOrNull); }

    final String cameraId;
    private final MotionCore core;
    private final boolean snapshot;
    private final OnMotion onMotion;
    private volatile long lastSample;
    private volatile boolean stopped;

    MotionDetector(String cameraId, String level, boolean snapshot, long cooldownMs, OnMotion onMotion) {
        this.cameraId = cameraId;
        this.core = new MotionCore(level, cooldownMs);
        this.snapshot = snapshot;
        this.onMotion = onMotion;
    }

    void stop() { stopped = true; }

    @Override
    public void onFrame(VideoFrame frame) {
        long now = System.currentTimeMillis();
        if (stopped || now - lastSample < SAMPLE_MS) return;
        lastSample = now;
        VideoFrame.I420Buffer i420 = null;
        try {
            i420 = frame.getBuffer().toI420();
            int w = i420.getWidth(), h = i420.getHeight();
            ByteBuffer y = i420.getDataY();
            int stride = i420.getStrideY();
            int[] grid = new int[MotionCore.W * MotionCore.H];
            for (int r = 0; r < MotionCore.H; r++) {
                int row = (r * h / MotionCore.H) * stride;
                for (int c = 0; c < MotionCore.W; c++) grid[r * MotionCore.W + c] = y.get(row + c * w / MotionCore.W) & 0xff;
            }
            if (!core.feed(grid, now)) return;
            byte[] nv21 = snapshot ? toNv21(i420) : null;
            int fw = w, fh = h;
            new Thread(() -> {
                byte[] jpeg = null;
                if (nv21 != null) {
                    try {
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        new YuvImage(nv21, ImageFormat.NV21, fw, fh, null).compressToJpeg(new Rect(0, 0, fw, fh), 70, out);
                        jpeg = out.toByteArray();
                    } catch (Throwable t) { Log.w(TAG, "snapshot", t); }
                }
                if (!stopped) onMotion.onMotion(jpeg);
            }, "motion-alert").start();
        } catch (Throwable t) {
            Log.w(TAG, "frame", t);
        } finally {
            if (i420 != null) i420.release();
        }
    }

    /** I420 planes -> NV21 (Y, then interleaved V/U), what YuvImage encodes to JPEG. */
    private static byte[] toNv21(VideoFrame.I420Buffer b) {
        int w = b.getWidth(), h = b.getHeight(), cw = (w + 1) / 2, ch = (h + 1) / 2;
        byte[] out = new byte[w * h + cw * ch * 2];
        ByteBuffer y = b.getDataY(), u = b.getDataU(), v = b.getDataV();
        for (int r = 0; r < h; r++) for (int c = 0; c < w; c++) out[r * w + c] = y.get(r * b.getStrideY() + c);
        int o = w * h;
        for (int r = 0; r < ch; r++) {
            for (int c = 0; c < cw; c++) {
                out[o++] = v.get(r * b.getStrideV() + c);
                out[o++] = u.get(r * b.getStrideU() + c);
            }
        }
        return out;
    }
}
