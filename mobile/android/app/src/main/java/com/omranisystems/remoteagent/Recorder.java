package com.omranisystems.remoteagent;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.util.Log;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.webrtc.EglBase;
import org.webrtc.EglRenderer;
import org.webrtc.GlRectDrawer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;
import org.webrtc.audio.JavaAudioDeviceModule;

/**
 * Records the shared camera (and the microphone when "Share audio" is on) to MP4 on this phone.
 *
 * Video: the camera track is drawn (GPU, no copies) into an H.264 encoder's input surface — exactly what the
 * dashboard sees, rotated upright, front camera not mirrored. Audio: AAC from the microphone; while viewers are
 * connected WebRTC owns the microphone, so its samples are used instead of opening a second recorder.
 *
 * Files are split every 5 minutes (on a keyframe), so if the phone dies only the current piece is lost.
 * Nothing here may throw into the caller: any failure stops the recording and is reported through onFail.
 */
class Recorder implements VideoSink {
    private static final String TAG = "RemoteRecorder";
    static final long PART_US = 5 * 60 * 1_000_000L;
    private static final int RATE = 48000;        // WebRTC's microphone is set to the same rate (NativeAgent)
    private static final int CHUNK = RATE / 50 * 2; // 20 ms of 16-bit mono

    interface OnFail { void onFail(String error); }

    final long since = System.currentTimeMillis();
    final boolean audio;
    private final Context ctx;
    private final EglBase.Context egl;
    private final OnFail onFail;
    private final String session = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date());

    private volatile boolean stopping;
    private volatile boolean setupStarted;
    private volatile EglRenderer renderer;
    private MediaCodec venc, aenc;
    private Surface input;
    private volatile Thread setupThread, videoThread, audioThread;

    // muxer state, guarded by mux
    private final Object mux = new Object();
    private Recordings.Out out;
    private int part = 0;
    private MediaFormat vFormat, aFormat;
    private boolean audioInFile;
    private int vTrack = -1, aTrack = -1;
    private boolean started, wrote;
    private long partFirstUs = -1, partLastUs = 0, videoSinceUs = -1;

    // audio input, guarded by enc
    private final Object enc = new Object();
    private long lastAudioUs = 0;
    private volatile long lastAudioOutMs = 0; // when the AAC encoder last produced sound

    /** true while WebRTC records the microphone (a viewer listens): take its samples instead of our own recorder */
    static volatile boolean webrtcMic;

    Recorder(Context ctx, EglBase.Context egl, boolean wantAudio, OnFail onFail) {
        this.ctx = ctx.getApplicationContext();
        this.egl = egl;
        this.onFail = onFail;
        this.audio = wantAudio && ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void fail(String what, Throwable t) {
        Log.e(TAG, what, t);
        if (stopping) return;
        try { onFail.onFail("recording stopped: " + (t.getMessage() == null ? what : t.getMessage())); }
        catch (Throwable ignored) {}
    }

    // ---- video ------------------------------------------------------------------------------------------------

    @Override
    public void onFrame(VideoFrame frame) {
        if (stopping) return;
        EglRenderer r = renderer;
        if (r != null) { r.onFrame(frame); return; }
        if (setupStarted) return; // encoder still starting: drop
        setupStarted = true;
        // the first frame gives the upright size; scale the long side to 1280 and keep it a multiple of 16
        int w = frame.getRotatedWidth(), h = frame.getRotatedHeight();
        float k = Math.min(1f, 1280f / Math.max(w, h));
        int ew = Math.max(16, Math.round(w * k / 16f) * 16), eh = Math.max(16, Math.round(h * k / 16f) * 16);
        setupThread = new Thread(() -> setup(ew, eh), "RemoteRecSetup");
        setupThread.start();
    }

    private void setup(int w, int h) {
        try {
            MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
            f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            f.setInteger(MediaFormat.KEY_BIT_RATE, w * h >= 1280 * 720 ? 4_000_000 : 2_000_000);
            f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
            f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
            venc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            venc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            input = venc.createInputSurface();
            venc.start();
            if (audio) startAudio();
            synchronized (mux) { openPart(); }

            EglRenderer r = new EglRenderer("RemoteRec");
            r.init(egl, EglBase.CONFIG_RECORDABLE, new GlRectDrawer());
            r.setLayoutAspectRatio(w / (float) h);
            r.createEglSurface(input);
            videoThread = new Thread(this::drainVideo, "RemoteRecVideo");
            videoThread.start();
            if (stopping) { r.release(); return; }
            renderer = r;
        } catch (Throwable t) {
            fail("setup", t);
        }
    }

    private void drainVideo() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        try {
            while (true) {
                int i = venc.dequeueOutputBuffer(info, 10_000);
                if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    synchronized (mux) { vFormat = venc.getOutputFormat(); }
                } else if (i >= 0) {
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0)
                        write(true, venc.getOutputBuffer(i), info);
                    venc.releaseOutputBuffer(i, false);
                    if (eos) return;
                }
            }
        } catch (Throwable t) {
            if (!stopping) fail("video", t);
        }
    }

    // ---- audio ------------------------------------------------------------------------------------------------

    private void startAudio() throws Exception {
        MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, 1);
        f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        f.setInteger(MediaFormat.KEY_BIT_RATE, 96_000);
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        aenc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        aenc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        aenc.start();
        audioThread = new Thread(this::ownMicLoop, "RemoteRecAudio");
        audioThread.start();
    }

    /** Our own microphone recorder, used only while WebRTC isn't recording. Ends the AAC stream on stop. */
    private void ownMicLoop() {
        AudioRecord rec = null;
        byte[] buf = new byte[CHUNK];
        try {
            while (!stopping) {
                if (webrtcMic) {
                    if (rec != null) { rec.stop(); rec.release(); rec = null; }
                    Thread.sleep(20);
                    continue;
                }
                if (rec == null) {
                    int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    rec = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(min, CHUNK * 4));
                    if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                        rec.release(); rec = null;
                        Thread.sleep(500); // microphone busy: try again shortly
                        continue;
                    }
                    rec.startRecording();
                }
                int n = rec.read(buf, 0, buf.length);
                if (n > 0) feed(buf, n);
            }
        } catch (Throwable t) {
            Log.w(TAG, "microphone", t); // the video keeps recording
        } finally {
            if (rec != null) { try { rec.stop(); } catch (Throwable ignored) {} rec.release(); }
        }
        endAudio();
    }

    /** Microphone samples from WebRTC (its recording thread) while a viewer is connected. */
    void onWebrtcSamples(JavaAudioDeviceModule.AudioSamples s) {
        if (stopping || !audio || s.getSampleRate() != RATE || s.getChannelCount() != 1
            || s.getAudioFormat() != AudioFormat.ENCODING_PCM_16BIT) return;
        byte[] d = s.getData();
        feed(d, d.length);
    }

    private void feed(byte[] pcm, int len) {
        synchronized (enc) {
            if (aenc == null || stopping) return;
            try {
                long us = System.nanoTime() / 1000 - (long) len / 2 * 1_000_000L / RATE;
                if (us <= lastAudioUs) us = lastAudioUs + 1;
                int i = aenc.dequeueInputBuffer(5_000);
                if (i < 0) return; // encoder busy: drop 20 ms rather than block
                ByteBuffer b = aenc.getInputBuffer(i);
                b.clear();
                int n = Math.min(len, b.remaining());
                b.put(pcm, 0, n);
                aenc.queueInputBuffer(i, 0, n, us, 0);
                lastAudioUs = us;
                drainAudio(false);
            } catch (Throwable t) {
                Log.w(TAG, "audio encode", t);
            }
        }
    }

    private void drainAudio(boolean untilEnd) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long deadline = System.currentTimeMillis() + 2000;
        while (true) {
            int i = aenc.dequeueOutputBuffer(info, untilEnd ? 10_000 : 0);
            if (i == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!untilEnd || System.currentTimeMillis() > deadline) return;
            } else if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                synchronized (mux) { aFormat = aenc.getOutputFormat(); }
            } else if (i >= 0) {
                boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    lastAudioOutMs = System.currentTimeMillis();
                    write(false, aenc.getOutputBuffer(i), info);
                }
                aenc.releaseOutputBuffer(i, false);
                if (eos) return;
            }
        }
    }

    private void endAudio() {
        synchronized (enc) {
            if (aenc == null) return;
            try {
                int i = aenc.dequeueInputBuffer(50_000);
                if (i >= 0) {
                    aenc.queueInputBuffer(i, 0, 0, lastAudioUs + 1, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    drainAudio(true);
                }
            } catch (Throwable t) { Log.w(TAG, "audio end", t); }
        }
    }

    // ---- the MP4 files --------------------------------------------------------------------------------------

    private void openPart() throws Exception {
        part++;
        String name = "Remote_" + session + (part > 1 ? "_part" + part : "") + ".mp4";
        out = Recordings.create(ctx, name, session, part);
        started = false; wrote = false; vTrack = -1; aTrack = -1;
        partFirstUs = -1; partLastUs = 0;
    }

    private void closePart() {
        if (out == null) return;
        Recordings.Out o = out;
        out = null;
        long ms = partFirstUs < 0 ? 0 : Math.max(0, (partLastUs - partFirstUs) / 1000);
        Recordings.finish(ctx, o, ms, started && wrote);
    }

    private void write(boolean video, ByteBuffer data, MediaCodec.BufferInfo info) {
        synchronized (mux) {
            if (out == null) return;
            try {
                boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                if (video) {
                    if (videoSinceUs < 0) videoSinceUs = info.presentationTimeUs;
                    // a new 5-minute piece starts on a keyframe
                    if (started && key && partFirstUs >= 0 && info.presentationTimeUs - partFirstUs >= PART_US) {
                        closePart();
                        openPart();
                    }
                    if (!started) {
                        if (!key || vFormat == null) return;
                        // wait (at most ~3 s) for sound, then record without it rather than nothing. A sound track
                        // that never gets a sample would make the whole file unreadable, so only add one while the
                        // microphone is actually delivering.
                        boolean withAudio = audio && aFormat != null && System.currentTimeMillis() - lastAudioOutMs < 2000;
                        if (audio && !withAudio && info.presentationTimeUs - videoSinceUs < 3_000_000) return;
                        vTrack = out.muxer.addTrack(vFormat);
                        if (withAudio) aTrack = out.muxer.addTrack(aFormat);
                        audioInFile = withAudio;
                        out.muxer.start();
                        started = true;
                    }
                } else if (!started || !audioInFile) {
                    return;
                }
                data.position(info.offset);
                data.limit(info.offset + info.size);
                out.muxer.writeSampleData(video ? vTrack : aTrack, data, info);
                wrote = true;
                if (video) {
                    if (partFirstUs < 0) partFirstUs = info.presentationTimeUs;
                    partLastUs = Math.max(partLastUs, info.presentationTimeUs);
                }
            } catch (Throwable t) {
                fail("write", t);
            }
        }
    }

    // ---- stop -------------------------------------------------------------------------------------------------

    /** Finishes the current file in the background (call after removing this sink from the track), then done. */
    void finish(Runnable done) {
        stopping = true;
        Thread t = new Thread(() -> {
            try {
                join(setupThread); // never tear down an encoder that is still being set up
                EglRenderer r = renderer;
                renderer = null;
                if (r != null) r.release(); // waits until nothing draws into the encoder any more
                if (venc != null) { try { venc.signalEndOfInputStream(); } catch (Throwable ignored) {} }
                join(videoThread);
                join(audioThread);
                synchronized (mux) { closePart(); }
            } catch (Throwable e) {
                Log.e(TAG, "finish", e);
            } finally {
                release(venc); release(aenc);
                if (input != null) input.release();
                if (done != null) { try { done.run(); } catch (Throwable ignored) {} }
            }
        }, "RemoteRecFinish");
        t.start();
    }

    private static void join(Thread t) {
        if (t == null) return;
        try { t.join(4000); } catch (InterruptedException ignored) {}
    }

    private static void release(MediaCodec c) {
        if (c == null) return;
        try { c.stop(); } catch (Throwable ignored) {}
        try { c.release(); } catch (Throwable ignored) {}
    }
}
