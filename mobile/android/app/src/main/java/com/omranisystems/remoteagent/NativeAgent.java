package com.omranisystems.remoteagent;

import android.content.Context;
import android.util.Log;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraVideoCapturer;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSink;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

/**
 * The camera agent, natively — same protocol as the browser agent on /connect, but owned by AgentService so it
 * keeps streaming when the app's screen is closed or swiped away.
 *
 *   agent -> server  hello { token, device, capabilities:[{cap:"camera"}] }      <- hello-ok
 *   viewer -> agent  signal { from, data:{kind:"request"} }  -> offer (camera track) -> answer -> ice both ways
 *
 * The camera only runs while at least one viewer is watching or the phone's own "Check camera" preview is open
 * (PreviewActivity). All state changes run on one thread.
 */
class NativeAgent {
    private static final String TAG = "RemoteAgent";

    // read by AgentPlugin.status() / the notification
    static volatile String state = "stopped"; // stopped | connecting | online | error
    static volatile int watchers = 0;
    static volatile String lastError = "";
    static volatile NativeAgent current; // the running agent, for PreviewActivity

    interface Listener { void onChanged(); }

    private final Context ctx;
    private final String wsUrl, httpBase, token, deviceId, deviceName;
    private final boolean front, audio;
    private final Listener listener;

    private final ExecutorService loop = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).build();
    private WebSocket ws;
    private boolean running = true;
    private long retryMs = 1000;

    private EglBase egl;
    private PeerConnectionFactory factory;
    private CameraVideoCapturer capturer;
    private SurfaceTextureHelper textures;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private final Map<String, PeerConnection> peers = new HashMap<>();
    private final Set<VideoSink> previews = new HashSet<>();

    NativeAgent(Context ctx, String wsUrl, String token, String deviceId, String deviceName, boolean front, boolean audio, Listener l) {
        this.ctx = ctx.getApplicationContext();
        this.wsUrl = wsUrl;
        this.httpBase = wsUrl.replaceFirst("^wss://", "https://").replaceFirst("^ws://", "http://").replaceFirst("/agent$", "");
        this.token = token;
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.front = front;
        this.audio = audio;
        this.listener = l;
    }

    void start() { current = this; loop.execute(this::connect); }

    boolean isFront() { return front; }

    // ---- local preview ("Check camera") ---------------------------------------------------------------------

    interface PreviewReady { void onReady(EglBase.Context egl); }

    /** Starts the camera if needed and hands back the EGL context the renderer must be initialised with. */
    void openPreview(PreviewReady ready) {
        loop.execute(() -> {
            ensureFactory();
            if (!startCamera()) { ready.onReady(null); return; }
            ready.onReady(egl.getEglBaseContext());
        });
    }

    /** Call after the renderer is initialised with the context from openPreview(). */
    void attachPreview(VideoSink sink) {
        loop.execute(() -> { previews.add(sink); if (videoTrack != null) videoTrack.addSink(sink); });
    }

    /** Detaches the renderer, releases the camera if nobody watches, then runs done (release the renderer there). */
    void closePreview(VideoSink sink, Runnable done) {
        if (loop.isShutdown()) { done.run(); return; }
        loop.execute(() -> {
            previews.remove(sink);
            if (videoTrack != null) videoTrack.removeSink(sink);
            if (peers.isEmpty() && previews.isEmpty()) stopCamera();
            done.run();
        });
    }

    void stop() {
        loop.execute(() -> {
            running = false;
            if (current == this) current = null;
            previews.clear();
            if (ws != null) ws.close(1000, "stopped");
            for (PeerConnection pc : peers.values()) pc.close();
            peers.clear();
            stopCamera();
            if (factory != null) { factory.dispose(); factory = null; }
            if (egl != null) { egl.release(); egl = null; }
            setState("stopped", 0, "");
        });
        loop.shutdown();
    }

    private void setState(String s, int w, String err) {
        state = s; watchers = w; if (err != null) lastError = err;
        if (listener != null) listener.onChanged();
    }

    // ---- signaling connection -------------------------------------------------------------------------------

    private void connect() {
        if (!running) return;
        setState("connecting", peers.size(), null);
        ws = http.newWebSocket(new Request.Builder().url(wsUrl).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                loop.execute(() -> {
                    try {
                        JSONObject dev = new JSONObject().put("id", deviceId).put("name", deviceName).put("platform", "android");
                        JSONArray caps = new JSONArray().put(new JSONObject().put("cap", "camera"));
                        socket.send(new JSONObject().put("type", "hello").put("token", token).put("device", dev).put("capabilities", caps).toString());
                    } catch (Exception e) { Log.w(TAG, "hello", e); }
                });
            }
            @Override public void onMessage(WebSocket socket, String text) { loop.execute(() -> onMessageText(text)); }
            @Override public void onClosed(WebSocket socket, int code, String reason) { loop.execute(() -> onDrop(code, reason)); }
            @Override public void onFailure(WebSocket socket, Throwable t, Response r) { loop.execute(() -> onDrop(0, t.getMessage())); }
        });
    }

    private void onDrop(int code, String reason) {
        for (PeerConnection pc : peers.values()) pc.close();
        peers.clear();
        if (previews.isEmpty()) stopCamera(); // an open preview keeps the camera while we reconnect
        if (!running) return;
        if (code == 4003) { // credentials rejected: retrying would only hit the rate limit
            setState("error", 0, "Access rejected — pair this device again from the dashboard.");
            return;
        }
        setState("connecting", 0, reason == null ? "" : reason);
        long wait = retryMs;
        retryMs = Math.min(retryMs * 2, 15000);
        new Thread(() -> {
            try { Thread.sleep(wait); } catch (InterruptedException ignored) {}
            if (!loop.isShutdown()) loop.execute(this::connect);
        }).start();
    }

    private void send(JSONObject o) { if (ws != null) ws.send(o.toString()); }

    private void onMessageText(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("hello-ok".equals(type)) {
                retryMs = 1000;
                setState("online", peers.size(), "");
            } else if ("signal".equals(type)) {
                onSignal(msg.optString("from"), msg.optJSONObject("data"));
            }
        } catch (Exception e) { Log.w(TAG, "message", e); }
    }

    private void signal(String to, JSONObject data) {
        try { send(new JSONObject().put("type", "signal").put("to", to).put("data", data)); }
        catch (Exception e) { Log.w(TAG, "signal", e); }
    }

    // ---- WebRTC ---------------------------------------------------------------------------------------------

    private void onSignal(String from, JSONObject data) throws Exception {
        if (data == null) return;
        String kind = data.optString("kind");
        PeerConnection pc = peers.get(from);
        if ("request".equals(kind)) {
            if (pc != null) { pc.close(); peers.remove(from); }
            openPeer(from);
        } else if ("answer".equals(kind) && pc != null) {
            JSONObject sdp = data.getJSONObject("sdp");
            pc.setRemoteDescription(new Sdp("answer"), new SessionDescription(
                SessionDescription.Type.fromCanonicalForm(sdp.getString("type")), sdp.getString("sdp")));
        } else if ("ice".equals(kind) && pc != null && data.has("candidate")) {
            JSONObject c = data.getJSONObject("candidate");
            pc.addIceCandidate(new IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.getString("candidate")));
        }
    }

    private void openPeer(String viewer) {
        try {
            ensureFactory();
            if (!startCamera()) { replyError(viewer, lastError); return; }
            PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(fetchIceServers());
            cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            PeerConnection pc = factory.createPeerConnection(cfg, new PeerObserver(viewer));
            if (pc == null) { replyError(viewer, "could not create the connection"); return; }
            pc.addTrack(videoTrack, Collections.singletonList("cam"));
            if (audioTrack != null) pc.addTrack(audioTrack, Collections.singletonList("cam"));
            peers.put(viewer, pc);
            setState(state, peers.size(), null);
            pc.createOffer(new Sdp("offer") {
                @Override public void onCreateSuccess(SessionDescription desc) {
                    loop.execute(() -> {
                        pc.setLocalDescription(new Sdp("local"), desc);
                        try {
                            JSONObject sdp = new JSONObject().put("type", desc.type.canonicalForm()).put("sdp", desc.description);
                            signal(viewer, new JSONObject().put("kind", "offer").put("sdp", sdp));
                        } catch (Exception e) { Log.w(TAG, "offer", e); }
                    });
                }
            }, new MediaConstraints());
        } catch (Exception e) {
            Log.w(TAG, "peer", e);
            replyError(viewer, e.getMessage());
        }
    }

    private void replyError(String viewer, String error) {
        try { signal(viewer, new JSONObject().put("kind", "error").put("error", error == null ? "camera error" : error)); }
        catch (Exception ignored) {}
    }

    private void closePeer(String viewer) {
        PeerConnection pc = peers.remove(viewer);
        if (pc != null) pc.close();
        if (peers.isEmpty() && previews.isEmpty()) stopCamera(); // nobody watching: release the camera (battery, privacy indicator)
        setState(state, peers.size(), null);
    }

    private List<PeerConnection.IceServer> fetchIceServers() {
        List<PeerConnection.IceServer> list = new ArrayList<>();
        try (Response r = http.newCall(new Request.Builder().url(httpBase + "/api/ice").build()).execute()) {
            JSONArray arr = new JSONObject(r.body().string()).getJSONArray("iceServers");
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.getJSONObject(i);
                List<String> urls = new ArrayList<>();
                Object u = s.get("urls");
                if (u instanceof JSONArray) for (int k = 0; k < ((JSONArray) u).length(); k++) urls.add(((JSONArray) u).getString(k));
                else urls.add(String.valueOf(u));
                PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
                if (s.has("username")) b.setUsername(s.getString("username")).setPassword(s.optString("credential"));
                list.add(b.createIceServer());
            }
        } catch (Exception e) {
            Log.w(TAG, "ice", e);
            list.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        }
        return list;
    }

    private void ensureFactory() {
        if (factory != null) return;
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions());
        egl = EglBase.create();
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
            .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
            .setAudioDeviceModule(JavaAudioDeviceModule.builder(ctx).createAudioDeviceModule())
            .createPeerConnectionFactory();
    }

    private boolean startCamera() {
        if (videoTrack != null) return true;
        Camera2Enumerator cams = new Camera2Enumerator(ctx);
        String pick = null;
        for (String name : cams.getDeviceNames()) {
            if (front ? cams.isFrontFacing(name) : cams.isBackFacing(name)) { pick = name; break; }
        }
        if (pick == null && cams.getDeviceNames().length > 0) pick = cams.getDeviceNames()[0];
        if (pick == null) { lastError = "no camera on this device"; return false; }
        capturer = cams.createCapturer(pick, new CameraVideoCapturer.CameraEventsHandler() {
            @Override public void onCameraError(String e) { lastError = "camera: " + e; if (listener != null) listener.onChanged(); }
            @Override public void onCameraDisconnected() { lastError = "camera taken by another app"; if (listener != null) listener.onChanged(); }
            @Override public void onCameraFreezed(String e) { lastError = "camera froze: " + e; }
            @Override public void onCameraOpening(String name) {}
            @Override public void onFirstFrameAvailable() { lastError = ""; }
            @Override public void onCameraClosed() {}
        });
        textures = SurfaceTextureHelper.create("RemoteCapture", egl.getEglBaseContext());
        videoSource = factory.createVideoSource(false);
        capturer.initialize(textures, ctx, videoSource.getCapturerObserver());
        capturer.startCapture(1280, 720, 30);
        videoTrack = factory.createVideoTrack("cam0", videoSource);
        for (VideoSink sink : previews) videoTrack.addSink(sink);
        if (audio) {
            audioSource = factory.createAudioSource(new MediaConstraints());
            audioTrack = factory.createAudioTrack("mic0", audioSource);
        }
        return true;
    }

    private void stopCamera() {
        if (capturer != null) {
            try { capturer.stopCapture(); } catch (InterruptedException ignored) {}
            capturer.dispose(); capturer = null;
        }
        if (videoTrack != null) { videoTrack.dispose(); videoTrack = null; }
        if (videoSource != null) { videoSource.dispose(); videoSource = null; }
        if (audioTrack != null) { audioTrack.dispose(); audioTrack = null; }
        if (audioSource != null) { audioSource.dispose(); audioSource = null; }
        if (textures != null) { textures.dispose(); textures = null; }
    }

    // ---- observers ------------------------------------------------------------------------------------------

    private class PeerObserver implements PeerConnection.Observer {
        private final String viewer;
        PeerObserver(String viewer) { this.viewer = viewer; }

        @Override public void onIceCandidate(IceCandidate c) {
            loop.execute(() -> {
                try {
                    JSONObject cand = new JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex);
                    signal(viewer, new JSONObject().put("kind", "ice").put("candidate", cand));
                } catch (Exception e) { Log.w(TAG, "ice out", e); }
            });
        }
        @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) {
            if (s == PeerConnection.PeerConnectionState.FAILED || s == PeerConnection.PeerConnectionState.DISCONNECTED
                || s == PeerConnection.PeerConnectionState.CLOSED) {
                loop.execute(() -> { if (peers.containsKey(viewer)) closePeer(viewer); });
            }
        }
        @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {}
        @Override public void onIceConnectionReceivingChange(boolean b) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
        @Override public void onAddStream(MediaStream s) {}
        @Override public void onRemoveStream(MediaStream s) {}
        @Override public void onDataChannel(DataChannel d) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver r, MediaStream[] s) {}
    }

    private static class Sdp implements SdpObserver {
        private final String what;
        Sdp(String what) { this.what = what; }
        @Override public void onCreateSuccess(SessionDescription d) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String e) { Log.w(TAG, what + " create: " + e); }
        @Override public void onSetFailure(String e) { Log.w(TAG, what + " set: " + e); }
    }
}
