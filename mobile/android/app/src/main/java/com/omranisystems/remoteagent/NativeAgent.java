package com.omranisystems.remoteagent;

import android.content.Context;
import android.util.Log;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import org.webrtc.audio.JavaAudioDeviceModule;

/**
 * The camera agent, natively — same protocol as the browser agent on /connect, but owned by AgentService so it
 * keeps streaming when the app's screen is closed or swiped away.
 *
 *   agent -> server  hello { token, device, capabilities:[{cap:"camera"}] }      <- hello-ok
 *   viewer -> agent  signal { from, data:{kind:"request"} }  -> offer (camera track) -> answer -> ice both ways
 *
 * The camera only runs while at least one viewer is watching, the phone's own "Check camera" preview is open
 * (PreviewActivity) or a recording is running (Recorder). Switching front/back happens in place (no reconnect).
 *
 * Stability rules (a crash here kills the whole app):
 *   - every task runs on this agent's single thread through post(), which drops work once the agent is stopped
 *     (late WebSocket / WebRTC callbacks) and logs instead of throwing;
 *   - the EGL context and the PeerConnectionFactory live for the whole process: previews and a restarted agent
 *     keep using them, nothing renders with a released context;
 *   - previews and the recorder are process-wide, so a restarted agent re-attaches them to its new camera track.
 */
class NativeAgent {
    private static final String TAG = "RemoteAgent";

    // read by AgentPlugin.status() / the notification / PreviewActivity
    static volatile String state = "stopped"; // stopped | connecting | online | error
    static volatile int watchers = 0;
    static volatile String lastError = "";
    static volatile boolean frontNow = false;
    static volatile NativeAgent current; // the running agent

    // process-wide WebRTC plumbing (created once, never disposed)
    private static EglBase EGL;
    private static PeerConnectionFactory FACTORY;
    private static final Set<VideoSink> PREVIEWS = Collections.synchronizedSet(new HashSet<>());
    static volatile Recorder RECORDER; // the running recording, if any

    interface Listener { void onChanged(); }

    private final Context ctx;
    private final String wsUrl, httpBase, token, deviceId, deviceName;
    private final boolean audio;
    private volatile boolean front;
    private final Listener listener;

    private final ExecutorService loop = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).build();
    private WebSocket ws;
    private volatile boolean running = true;
    private long retryMs = 1000;

    private CameraVideoCapturer capturer;
    private SurfaceTextureHelper textures;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    // One connection per viewer AND camera: key = viewerId + "|" + cameraId ("" = this phone's own camera).
    // The dashboard can watch the phone and the cameras it relays (M7c) at the same time.
    private final Map<String, PeerConnection> peers = new HashMap<>();
    private final Map<String, RtspRelay> relays = new HashMap<>(); // cameraId -> relay, while someone watches it

    private static String key(String viewer, String camera) { return viewer + "|" + camera; }
    private static String viewerOf(String key) { return key.substring(0, key.lastIndexOf('|')); }
    private static String cameraOf(String key) { return key.substring(key.lastIndexOf('|') + 1); }

    private int phoneWatchers() {
        int n = 0;
        for (String k : peers.keySet()) if (cameraOf(k).isEmpty()) n++;
        return n;
    }

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

    /** Runs on the agent thread; silently dropped once stopped; never lets an exception kill the app. */
    private boolean post(Runnable r) {
        if (!running || loop.isShutdown()) return false;
        try {
            loop.execute(() -> {
                try { r.run(); } catch (Throwable t) { Log.e(TAG, "task failed", t); }
            });
            return true;
        } catch (Throwable ignored) { return false; /* shut down between the check and execute */ }
    }

    /** Someone still needs the camera: a viewer, the phone's preview or a recording. */
    private boolean cameraNeeded() {
        return phoneWatchers() > 0 || !PREVIEWS.isEmpty() || RECORDER != null;
    }

    private void changed() {
        try { if (listener != null) listener.onChanged(); } catch (Throwable t) { Log.w(TAG, "listener", t); }
    }

    private ConnectivityManager.NetworkCallback netWatch;

    void start() {
        current = this;
        frontNow = front;
        post(this::connect);
        // joining / leaving the owner's Wi-Fi adds / removes the "discovery" capability on the dashboard
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            netWatch = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { post(NativeAgent.this::refreshCapabilities); }
                @Override public void onLost(Network n) { post(NativeAgent.this::refreshCapabilities); }
                @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { post(NativeAgent.this::refreshCapabilities); }
            };
            try { cm.registerDefaultNetworkCallback(netWatch); } catch (Exception e) { Log.w(TAG, "network watch", e); netWatch = null; }
        }
        // a "Check camera" view or a recording running across a restart: feed it from this agent's camera right away
        if (!PREVIEWS.isEmpty() || RECORDER != null) post(() -> { ensureFactory(); startCamera(); });
    }

    /** Stops everything, then runs done (on the agent thread) — callers start a new agent only after that. */
    void stop(Runnable done) {
        if (!running || loop.isShutdown()) { if (done != null) done.run(); return; }
        post(() -> {
            if (current == this) current = null;
            if (netWatch != null) {
                ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
                try { if (cm != null) cm.unregisterNetworkCallback(netWatch); } catch (Exception ignored) {}
                netWatch = null;
            }
            if (ws != null) ws.close(1000, "stopped");
            for (PeerConnection pc : peers.values()) pc.dispose();
            peers.clear();
            stopRelays();
            stopCamera();
            state = "stopped"; watchers = 0; lastError = "";
            running = false; // from here on, late callbacks are dropped by post()
            loop.shutdown();
            changed();
            if (done != null) {
                try { done.run(); } catch (Throwable t) { Log.e(TAG, "after stop", t); }
            }
        });
    }

    private void setState(String s, int w, String err) {
        state = s; watchers = w; if (err != null) lastError = err;
        changed();
    }

    // ---- camera switch + local preview ("Check camera") -----------------------------------------------------

    /** Front/back in place: viewers keep their connection and just see the other camera. */
    void switchCamera(boolean toFront) {
        post(() -> {
            front = toFront;
            frontNow = toFront;
            if (capturer == null) return; // not capturing: the next start picks the new side
            String name = pickCamera();
            if (name == null) return;
            capturer.switchCamera(new CameraVideoCapturer.CameraSwitchHandler() {
                @Override public void onCameraSwitchDone(boolean isFront) { frontNow = isFront; }
                @Override public void onCameraSwitchError(String e) { lastError = "camera switch: " + e; changed(); }
            }, name);
        });
    }

    interface PreviewReady { void onReady(EglBase.Context egl); }

    /** Starts the camera if needed and hands back the EGL context the renderer must be initialised with. */
    void openPreview(PreviewReady ready) {
        post(() -> {
            ensureFactory();
            ready.onReady(startCamera() ? EGL.getEglBaseContext() : null);
        });
    }

    /** Call after the renderer is initialised with the context from openPreview(). */
    static void attachPreview(VideoSink sink) {
        PREVIEWS.add(sink);
        NativeAgent a = current;
        if (a != null) a.post(() -> { if (a.videoTrack != null) a.videoTrack.addSink(sink); });
    }

    /** Detaches the renderer from whichever agent runs now, releases the camera if nobody watches, then runs done. */
    static void closePreview(VideoSink sink, Runnable done) {
        PREVIEWS.remove(sink);
        NativeAgent a = current;
        if (a == null || !a.running) { done.run(); return; }
        a.post(() -> {
            if (a.videoTrack != null) a.videoTrack.removeSink(sink);
            if (!a.cameraNeeded()) a.stopCamera();
            done.run();
        });
    }

    // ---- recording (saved on this phone) ----------------------------------------------------------------------

    interface Result { void onResult(String error); }

    /** Starts recording what the dashboard sees (+ microphone when sharing audio); error is null on success. */
    void startRecording(Result result) {
        boolean queued = post(() -> {
            if (RECORDER != null) { result.onResult(null); return; }
            ensureFactory();
            if (!startCamera()) { result.onResult(lastError.isEmpty() ? "camera unavailable" : lastError); return; }
            Recorder r = new Recorder(ctx, EGL.getEglBaseContext(), audio, err -> {
                lastError = err;
                stopRecording(null);
            });
            RECORDER = r;
            videoTrack.addSink(r);
            changed();
            result.onResult(null);
        });
        if (!queued) result.onResult("Start sharing first.");
    }

    /** Stops the recording (if any): detaches it from the camera, finishes the file in the background, then done. */
    static void stopRecording(Runnable done) {
        Recorder r = RECORDER;
        if (r == null) { if (done != null) done.run(); return; }
        RECORDER = null;
        Runnable finish = () -> r.finish(() -> {
            NativeAgent now = current;
            if (now != null) now.changed();
            if (done != null) done.run();
        });
        NativeAgent a = current;
        boolean queued = a != null && a.post(() -> {
            if (a.videoTrack != null) a.videoTrack.removeSink(r);
            if (!a.cameraNeeded()) a.stopCamera();
            a.changed();
            finish.run();
        });
        if (!queued) finish.run();
    }

    // ---- signaling connection -------------------------------------------------------------------------------

    private void connect() {
        if (!running) return;
        setState("connecting", peers.size(), null);
        ws = http.newWebSocket(new Request.Builder().url(wsUrl).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                post(() -> {
                    try {
                        JSONObject dev = new JSONObject().put("id", deviceId).put("name", deviceName).put("platform", "android");
                        JSONArray caps = capabilities();
                        socket.send(new JSONObject().put("type", "hello").put("token", token).put("device", dev).put("capabilities", caps).toString());
                    } catch (Exception e) { Log.w(TAG, "hello", e); }
                });
            }
            @Override public void onMessage(WebSocket socket, String text) { post(() -> onMessageText(text)); }
            @Override public void onClosed(WebSocket socket, int code, String reason) { post(() -> onDrop(socket, code, reason)); }
            @Override public void onFailure(WebSocket socket, Throwable t, Response r) { post(() -> onDrop(socket, 0, t.getMessage())); }
        });
    }

    private void onDrop(WebSocket socket, int code, String reason) {
        if (socket != ws) return; // an older socket closing late
        for (PeerConnection pc : peers.values()) pc.dispose();
        peers.clear();
        stopRelays();
        if (!cameraNeeded()) stopCamera(); // an open preview or a recording keeps the camera while we reconnect
        if (!running) return;
        if (code == 4003) { // credentials rejected: retrying would only hit the rate limit
            setState("error", 0, "Access rejected — pair this device again from the dashboard.");
            return;
        }
        setState("connecting", 0, reason == null ? "" : reason);
        long wait = retryMs;
        retryMs = Math.min(retryMs * 2, 15000);
        Thread t = new Thread(() -> {
            try { Thread.sleep(wait); } catch (InterruptedException ignored) {}
            post(this::connect);
        });
        t.setDaemon(true);
        t.start();
    }

    private void send(JSONObject o) { if (ws != null) ws.send(o.toString()); }

    /** What this phone offers: the camera, plus camera discovery while on one of the owner's networks (M7). */
    private JSONArray capabilities() throws Exception {
        JSONObject camera = new JSONObject().put("cap", "camera");
        // Cameras relayed from the owner's network (M7c): only while the phone is on it (it can't reach them elsewhere)
        if (HomeNetwork.current(ctx).trusted) {
            JSONArray list = new JSONArray();
            for (CameraStore.Cam c : CameraStore.list(ctx)) {
                if (c.relay) list.put(new JSONObject().put("id", c.id).put("name", c.name).put("source", "rtsp"));
            }
            if (list.length() > 0) {
                JSONArray cams = new JSONArray().put(new JSONObject().put("id", "phone").put("name", "This phone"));
                for (int i = 0; i < list.length(); i++) cams.put(list.getJSONObject(i));
                camera.put("cameras", cams);
            }
        }
        JSONArray caps = new JSONArray().put(camera);
        JSONObject discovery = Discovery.capability(ctx);
        if (discovery != null) caps.put(discovery);
        return caps;
    }

    private String lastCaps = "";

    /** Tells the server when the capabilities change (e.g. the phone joined or left the owner's Wi-Fi). */
    private void refreshCapabilities() {
        if (ws == null || !"online".equals(state)) return;
        try {
            JSONArray caps = capabilities();
            if (caps.toString().equals(lastCaps)) return;
            lastCaps = caps.toString();
            send(new JSONObject().put("type", "caps").put("capabilities", caps));
        } catch (Exception e) { Log.w(TAG, "caps", e); }
    }

    /** Called after the owner trusts / forgets a network in the app. */
    void networkChanged() { post(this::refreshCapabilities); }

    /** A dashboard action. Only "discovery / scan" exists on the phone: results stream back, then the full list. */
    private void onAction(JSONObject msg) throws Exception {
        String reqId = msg.optString("reqId");
        if (!"discovery".equals(msg.optString("cap")) || !"scan".equals(msg.optString("do"))) {
            send(new JSONObject().put("type", "result").put("reqId", reqId).put("ok", false).put("error", "not supported on this phone"));
            return;
        }
        // A scan takes a few seconds: run it off the agent thread, reply through post() (dropped if stopped meanwhile)
        Thread t = new Thread(() -> {
            JSONObject result = new JSONObject();
            try {
                JSONArray hosts = Discovery.scan(ctx, host -> post(() -> {
                    try { send(new JSONObject().put("type", "stream").put("reqId", reqId).put("chunk", host)); }
                    catch (Exception e) { Log.w(TAG, "scan chunk", e); }
                }));
                result.put("type", "result").put("reqId", reqId).put("ok", true).put("data", new JSONObject().put("hosts", hosts));
            } catch (Throwable e) {
                try { result.put("type", "result").put("reqId", reqId).put("ok", false).put("error", e.getMessage() == null ? "scan failed" : e.getMessage()); }
                catch (Exception ignored) {}
            }
            post(() -> send(result));
        }, "discovery");
        t.setDaemon(true);
        t.start();
    }

    private void onMessageText(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("hello-ok".equals(type)) {
                retryMs = 1000;
                setState("online", peers.size(), "");
                lastCaps = capabilities().toString();
            } else if ("signal".equals(type)) {
                onSignal(msg.optString("from"), msg.optJSONObject("data"));
            } else if ("action".equals(type)) {
                onAction(msg);
            }
        } catch (Exception e) { Log.w(TAG, "message", e); }
    }

    /** `to` is a connection key (viewer|camera) or a plain viewer id; replies name their camera so the dashboard can tell them apart. */
    private void signal(String to, JSONObject data) {
        try {
            if (to.contains("|")) {
                String camera = cameraOf(to);
                if (!camera.isEmpty()) data.put("camera", camera);
                to = viewerOf(to);
            }
            send(new JSONObject().put("type", "signal").put("to", to).put("data", data));
        }
        catch (Exception e) { Log.w(TAG, "signal", e); }
    }

    // ---- WebRTC ---------------------------------------------------------------------------------------------

    private void onSignal(String from, JSONObject data) throws Exception {
        if (data == null) return;
        String kind = data.optString("kind");
        String camera = data.optString("camera", "");
        if ("phone".equals(camera)) camera = "";
        String k = key(from, camera);
        PeerConnection pc = peers.get(k);
        if ("request".equals(kind)) {
            if (pc != null) closePeer(k);
            openPeer(k);
        } else if ("answer".equals(kind) && pc != null) {
            JSONObject sdp = data.getJSONObject("sdp");
            pc.setRemoteDescription(new Sdp("answer"), new SessionDescription(
                SessionDescription.Type.fromCanonicalForm(sdp.getString("type")), sdp.getString("sdp")));
        } else if ("ice".equals(kind) && pc != null && data.has("candidate")) {
            JSONObject c = data.getJSONObject("candidate");
            pc.addIceCandidate(new IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.getString("candidate")));
        }
    }

    private void openPeer(String viewer) { // viewer = key(viewerId, cameraId)
        try {
            ensureFactory();
            String camera = cameraOf(viewer);
            VideoTrack video;
            if (camera.isEmpty()) {
                if (!startCamera()) { replyError(viewer, lastError); return; }
                video = videoTrack;
            } else {
                RtspRelay relay = relays.get(camera);
                if (relay == null) {
                    CameraStore.Cam cam = CameraStore.get(ctx, camera);
                    if (cam == null || !cam.relay) { replyError(viewer, "This camera isn't shared from the phone any more."); return; }
                    if (!HomeNetwork.current(ctx).trusted) { replyError(viewer, "The phone isn't on the camera's network right now."); return; }
                    relay = new RtspRelay(ctx, EGL.getEglBaseContext(), FACTORY, cam, msg -> post(() -> relayFailed(camera, msg)));
                    relays.put(camera, relay);
                }
                video = relay.track();
            }
            PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(fetchIceServers());
            cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            PeerConnection pc = FACTORY.createPeerConnection(cfg, new PeerObserver(viewer));
            if (pc == null) { replyError(viewer, "could not create the connection"); return; }
            pc.addTrack(video, Collections.singletonList("cam"));
            if (camera.isEmpty() && audioTrack != null) pc.addTrack(audioTrack, Collections.singletonList("cam"));
            peers.put(viewer, pc);
            setState(state, peers.size(), null);
            pc.createOffer(new Sdp("offer") {
                @Override public void onCreateSuccess(SessionDescription desc) {
                    post(() -> {
                        if (peers.get(viewer) != pc) return; // replaced or closed meanwhile
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

    /** The relayed camera stopped playing: tell its viewers and close their connections. */
    private void relayFailed(String camera, String message) {
        for (String k : new ArrayList<>(peers.keySet())) {
            if (cameraOf(k).equals(camera)) { replyError(k, message); closePeer(k); }
        }
        RtspRelay r = relays.remove(camera);
        if (r != null) r.stop();
    }

    private void stopRelays() {
        for (RtspRelay r : relays.values()) r.stop();
        relays.clear();
    }

    private void replyError(String viewer, String error) {
        try { signal(viewer, new JSONObject().put("kind", "error").put("error", error == null ? "camera error" : error)); }
        catch (Exception ignored) {}
    }

    private void closePeer(String viewer) {
        PeerConnection pc = peers.remove(viewer);
        if (pc != null) pc.dispose();
        String camera = cameraOf(viewer);
        if (!camera.isEmpty()) {
            boolean watched = false;
            for (String k : peers.keySet()) if (cameraOf(k).equals(camera)) watched = true;
            RtspRelay r = watched ? null : relays.remove(camera);
            if (r != null) r.stop(); // nobody watches this camera any more: stop pulling its stream
        }
        if (!cameraNeeded()) stopCamera(); // nobody watching or recording: release the camera (battery, privacy indicator)
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
        synchronized (NativeAgent.class) {
            if (FACTORY != null) return;
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions());
            EGL = EglBase.create();
            FACTORY = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(EGL.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(EGL.getEglBaseContext()))
                .setAudioDeviceModule(JavaAudioDeviceModule.builder(ctx)
                    // mono 48 kHz like the recorder, which reuses these samples while a viewer holds the microphone
                    .setInputSampleRate(48000)
                    .setUseStereoInput(false)
                    .setSamplesReadyCallback(s -> { Recorder r = RECORDER; if (r != null) r.onWebrtcSamples(s); })
                    .setAudioRecordStateCallback(new JavaAudioDeviceModule.AudioRecordStateCallback() {
                        @Override public void onWebRtcAudioRecordStart() { Recorder.webrtcMic = true; }
                        @Override public void onWebRtcAudioRecordStop() { Recorder.webrtcMic = false; }
                    })
                    .createAudioDeviceModule())
                .createPeerConnectionFactory();
        }
    }

    private String pickCamera() {
        Camera2Enumerator cams = new Camera2Enumerator(ctx);
        for (String name : cams.getDeviceNames()) {
            if (front ? cams.isFrontFacing(name) : cams.isBackFacing(name)) return name;
        }
        return cams.getDeviceNames().length > 0 ? cams.getDeviceNames()[0] : null;
    }

    private boolean startCamera() {
        if (videoTrack != null) return true;
        String pick = pickCamera();
        if (pick == null) { lastError = "no camera on this device"; return false; }
        capturer = new Camera2Enumerator(ctx).createCapturer(pick, new CameraVideoCapturer.CameraEventsHandler() {
            @Override public void onCameraError(String e) { lastError = "camera: " + e; changed(); }
            @Override public void onCameraDisconnected() { lastError = "camera taken by another app"; changed(); }
            @Override public void onCameraFreezed(String e) { lastError = "camera froze: " + e; }
            @Override public void onCameraOpening(String name) {}
            @Override public void onFirstFrameAvailable() { lastError = ""; }
            @Override public void onCameraClosed() {}
        });
        textures = SurfaceTextureHelper.create("RemoteCapture", EGL.getEglBaseContext());
        videoSource = FACTORY.createVideoSource(false);
        capturer.initialize(textures, ctx, videoSource.getCapturerObserver());
        capturer.startCapture(1280, 720, 30);
        frontNow = front;
        videoTrack = FACTORY.createVideoTrack("cam0", videoSource);
        synchronized (PREVIEWS) { for (VideoSink sink : PREVIEWS) videoTrack.addSink(sink); }
        Recorder rec = RECORDER;
        if (rec != null) videoTrack.addSink(rec);
        if (audio) {
            audioSource = FACTORY.createAudioSource(new MediaConstraints());
            audioTrack = FACTORY.createAudioTrack("mic0", audioSource);
        }
        return true;
    }

    private void stopCamera() {
        if (capturer != null) {
            try { capturer.stopCapture(); } catch (InterruptedException ignored) {}
            capturer.dispose(); capturer = null;
        }
        if (videoTrack != null) {
            synchronized (PREVIEWS) { for (VideoSink sink : PREVIEWS) videoTrack.removeSink(sink); }
            Recorder rec = RECORDER;
            if (rec != null) videoTrack.removeSink(rec);
            videoTrack.dispose(); videoTrack = null;
        }
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
            post(() -> {
                try {
                    JSONObject cand = new JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex);
                    signal(viewer, new JSONObject().put("kind", "ice").put("candidate", cand));
                } catch (Exception e) { Log.w(TAG, "ice out", e); }
            });
        }
        @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) {
            if (s == PeerConnection.PeerConnectionState.FAILED || s == PeerConnection.PeerConnectionState.DISCONNECTED
                || s == PeerConnection.PeerConnectionState.CLOSED) {
                post(() -> { if (peers.containsKey(viewer)) closePeer(viewer); });
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
