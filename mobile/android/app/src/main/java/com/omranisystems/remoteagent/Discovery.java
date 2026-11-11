package com.omranisystems.remoteagent;

import android.content.Context;
import android.net.wifi.WifiManager;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Runs camera discovery on the phone (M7a), for the app's own screen and for the dashboard (NativeAgent).
 * One scan at a time; only on a trusted network (HomeNetwork); results as JSON:
 *   { ip, kind: camera|maybe|other, ports:[{port, label}], manufacturer, model, name, onvif }
 */
final class Discovery {
    private static final Object LOCK = new Object();
    private static NetworkScanner running;

    static final class NotTrusted extends Exception {
        NotTrusted(String m) { super(m); }
    }

    /** Blocks for a few seconds. Throws NotTrusted off the owner's network, IllegalStateException if a scan is running. */
    static JSONArray scan(Context ctx, Consumer<JSONObject> onUpdate) throws Exception {
        HomeNetwork.Status s = HomeNetwork.current(ctx);
        if (!s.wifi) throw new NotTrusted("This phone isn't on Wi-Fi.");
        if (!s.trusted) throw new NotTrusted("This Wi-Fi isn't marked as your network. Open the app on the phone and choose \"This is my network\".");

        NetworkScanner scanner = new NetworkScanner(400, 128);
        synchronized (LOCK) {
            if (running != null) throw new IllegalStateException("A scan is already running.");
            running = scanner;
        }
        // Lets the ONVIF multicast answers in while the screen is off
        WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wm == null ? null : wm.createMulticastLock("remote-discovery");
        try {
            if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
            List<NetworkScanner.Host> hosts = scanner.scan(
                NetworkScanner.subnet(s.address, s.prefix),
                NetworkScanner.ONVIF_MULTICAST,
                h -> { if (onUpdate != null) { try { onUpdate.accept(toJson(h)); } catch (JSONException ignored) {} } });
            JSONArray out = new JSONArray();
            for (NetworkScanner.Host h : hosts) out.put(toJson(h));
            return out;
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
            synchronized (LOCK) { running = null; }
        }
    }

    static JSONObject toJson(NetworkScanner.Host h) throws JSONException {
        JSONArray ports = new JSONArray();
        for (int p : h.ports) ports.put(new JSONObject().put("port", p).put("label", NetworkScanner.PORTS.getOrDefault(p, "")));
        return new JSONObject()
            .put("ip", h.ip)
            .put("kind", h.kind())
            .put("ports", ports)
            .put("manufacturer", h.manufacturer)
            .put("model", h.model)
            .put("name", h.name)
            .put("onvif", h.onvifAddress);
    }

    /** The capability advertised to the server while on a trusted network, or null. */
    static JSONObject capability(Context ctx) throws JSONException {
        HomeNetwork.Status s = HomeNetwork.current(ctx);
        if (!s.trusted) return null;
        return new JSONObject().put("cap", "discovery").put("network", new JSONObject().put("name", s.ssid).put("subnet", s.subnetText()));
    }
}
