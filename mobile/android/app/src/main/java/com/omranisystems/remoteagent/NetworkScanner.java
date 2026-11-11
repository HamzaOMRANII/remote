package com.omranisystems.remoteagent;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentSkipListSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the cameras on the owner's own network (M7, docs/M7-camera-discovery.md). Plain Java, no Android
 * classes, so it can be tested on any JVM (see mobile/test/NetworkScannerCheck.java).
 *
 *   1. ONVIF WS-Discovery: one Probe to the multicast address 239.255.255.250:3702; cameras answer with their
 *      service address and, often, their brand and model.
 *   2. Port check: a TCP connect (no data sent) to the usual camera ports on every address of the subnet.
 *
 * Nothing is logged in to: no passwords are tried, ever. The owner adds credentials for the cameras they choose.
 */
final class NetworkScanner {
    /** Camera-related ports and what they usually mean. */
    static final Map<Integer, String> PORTS = new LinkedHashMap<>();
    static {
        PORTS.put(554, "RTSP video");
        PORTS.put(8554, "RTSP video");
        PORTS.put(80, "web page");
        PORTS.put(8080, "web page");
        PORTS.put(443, "web page (https)");
        PORTS.put(8000, "Hikvision");
        PORTS.put(37777, "Dahua");
        PORTS.put(1935, "RTMP");
    }
    static final InetSocketAddress ONVIF_MULTICAST = new InetSocketAddress("239.255.255.250", 3702);

    /** One device found on the network. Fields only grow while the scan runs. */
    static final class Host {
        final String ip;
        /** Sorted and thread-safe: the port checks add to it while the results are being read. */
        final ConcurrentSkipListSet<Integer> ports = new ConcurrentSkipListSet<>();
        volatile String manufacturer = "", model = "", name = "", onvifAddress = "";

        Host(String ip) { this.ip = ip; }

        boolean onvif() { return !onvifAddress.isEmpty(); }

        /** "camera": answers ONVIF or has an RTSP port; "maybe": only web or vendor ports; "other": nothing camera-like. */
        String kind() {
            if (onvif() || ports.contains(554) || ports.contains(8554)) return "camera";
            if (ports.contains(8000) || ports.contains(37777)) return "camera";
            return ports.isEmpty() ? "other" : "maybe";
        }
    }

    private final int timeoutMs;
    private final int parallel;
    private volatile boolean cancelled;

    NetworkScanner(int timeoutMs, int parallel) {
        this.timeoutMs = timeoutMs;
        this.parallel = parallel;
    }

    void cancel() { cancelled = true; }

    /**
     * Scans `targets` (the subnet's addresses) and asks `probeTo` (normally ONVIF_MULTICAST) who speaks ONVIF.
     * `onUpdate` is called from worker threads each time a device appears or learns something new.
     * Returns every device with at least one open port or an ONVIF answer, sorted by address.
     */
    List<Host> scan(List<InetAddress> targets, InetSocketAddress probeTo, Consumer<Host> onUpdate) throws InterruptedException {
        Map<String, Host> found = Collections.synchronizedMap(new LinkedHashMap<>());
        Thread onvif = new Thread(() -> probeOnvif(probeTo, found, onUpdate), "onvif-probe");
        onvif.setDaemon(true);
        onvif.start();

        ExecutorService pool = Executors.newFixedThreadPool(parallel);
        for (InetAddress addr : targets) {
            for (int port : PORTS.keySet()) {
                pool.execute(() -> {
                    if (cancelled || !open(addr, port)) return;
                    Host h;
                    synchronized (found) {
                        h = found.computeIfAbsent(addr.getHostAddress(), Host::new);
                        h.ports.add(port);
                    }
                    if (onUpdate != null) onUpdate.accept(h);
                });
            }
        }
        pool.shutdown();
        pool.awaitTermination(5, TimeUnit.MINUTES);
        onvif.join(timeoutMs * 4L + 3000);

        List<Host> list;
        synchronized (found) { list = new ArrayList<>(found.values()); }
        list.sort((a, b) -> compareIp(a.ip, b.ip));
        return list;
    }

    private boolean open(InetAddress addr, int port) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(addr, port), timeoutMs);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    // ---- ONVIF ---------------------------------------------------------------------------------------------

    static String probeMessage(String messageId) {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            + "<e:Envelope xmlns:e=\"http://www.w3.org/2003/05/soap-envelope\""
            + " xmlns:w=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\""
            + " xmlns:d=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\""
            + " xmlns:dn=\"http://www.onvif.org/ver10/network/wsdl\">"
            + "<e:Header><w:MessageID>uuid:" + messageId + "</w:MessageID>"
            + "<w:To e:mustUnderstand=\"true\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"
            + "<w:Action e:mustUnderstand=\"true\">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>"
            + "<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>";
    }

    private void probeOnvif(InetSocketAddress to, Map<String, Host> found, Consumer<Host> onUpdate) {
        byte[] probe = probeMessage(UUID.randomUUID().toString()).getBytes(StandardCharsets.UTF_8);
        try (DatagramSocket sock = new DatagramSocket()) {
            sock.setSoTimeout(timeoutMs);
            // twice: UDP can be lost, and some cameras ignore the first probe after waking up
            sock.send(new DatagramPacket(probe, probe.length, to));
            long until = System.currentTimeMillis() + timeoutMs * 4L + 1500;
            boolean resent = false;
            byte[] buf = new byte[65_535];
            while (!cancelled && System.currentTimeMillis() < until) {
                if (!resent && System.currentTimeMillis() > until - timeoutMs * 2L) {
                    sock.send(new DatagramPacket(probe, probe.length, to));
                    resent = true;
                }
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try { sock.receive(p); } catch (SocketTimeoutException e) { continue; }
                String xml = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                if (!xml.contains("ProbeMatch")) continue;
                String ip = p.getAddress().getHostAddress();
                Host h;
                synchronized (found) {
                    h = found.computeIfAbsent(ip, Host::new);
                    applyProbeMatch(h, xml);
                }
                if (onUpdate != null) onUpdate.accept(h);
            }
        } catch (IOException e) {
            // no multicast on this network: the port check still finds the cameras
        }
    }

    private static final Pattern XADDRS = Pattern.compile("<[^>]*XAddrs[^>]*>([^<]+)<");
    private static final Pattern SCOPES = Pattern.compile("<[^>]*Scopes[^>]*>([^<]+)<");

    /** Reads the service address and the brand/model/name scopes of a ProbeMatch answer. */
    static void applyProbeMatch(Host h, String xml) {
        Matcher x = XADDRS.matcher(xml);
        if (x.find()) h.onvifAddress = x.group(1).trim().split("\\s+")[0];
        Matcher s = SCOPES.matcher(xml);
        if (!s.find()) return;
        for (String scope : s.group(1).trim().split("\\s+")) {
            String value = scopeValue(scope, "hardware/");
            if (value != null && h.model.isEmpty()) h.model = value;
            value = scopeValue(scope, "name/");
            if (value != null && h.name.isEmpty()) h.name = value;
            value = scopeValue(scope, "mfr/");
            if (value == null) value = scopeValue(scope, "manufacturer/");
            if (value != null && h.manufacturer.isEmpty()) h.manufacturer = value;
        }
        // Many cameras put the brand in "name" only (e.g. name/HIKVISION)
        if (h.manufacturer.isEmpty() && !h.name.isEmpty()) h.manufacturer = h.name;
    }

    private static String scopeValue(String scope, String key) {
        int i = scope.indexOf("onvif://www.onvif.org/" + key);
        if (i < 0) return null;
        String raw = scope.substring(i + ("onvif://www.onvif.org/" + key).length());
        try { return URLDecoder.decode(raw, "UTF-8").replace('_', ' ').trim(); } catch (Exception e) { return raw; }
    }

    // ---- addresses -----------------------------------------------------------------------------------------

    /** True for 10/8, 172.16/12, 192.168/16: discovery never touches public addresses. */
    static boolean isPrivate(InetAddress a) {
        byte[] b = a.getAddress();
        if (b.length != 4) return false;
        int o0 = b[0] & 0xff, o1 = b[1] & 0xff;
        return o0 == 10 || (o0 == 172 && o1 >= 16 && o1 <= 31) || (o0 == 192 && o1 == 168);
    }

    /**
     * The addresses to check around `self`: its subnet if the prefix is 22–30, otherwise its /24 (a bigger
     * network would take too long and is rarely a home). `self` itself is left out. Empty if `self` isn't private.
     */
    static List<InetAddress> subnet(InetAddress self, int prefix) {
        List<InetAddress> out = new ArrayList<>();
        if (!isPrivate(self)) return out;
        int p = prefix >= 22 && prefix <= 30 ? prefix : 24;
        byte[] b = self.getAddress();
        int ip = ((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
        int mask = p == 0 ? 0 : -1 << (32 - p);
        int net = ip & mask, size = 1 << (32 - p);
        for (int i = 1; i < size - 1; i++) {
            int a = net + i;
            if (a == ip) continue;
            try {
                out.add(InetAddress.getByAddress(new byte[] { (byte) (a >>> 24), (byte) (a >>> 16), (byte) (a >>> 8), (byte) a }));
            } catch (IOException ignored) { /* 4 bytes: never thrown */ }
        }
        return out;
    }

    static int compareIp(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.min(x.length, y.length); i++) {
            int c = Integer.compare(Integer.parseInt(x[i]), Integer.parseInt(y[i]));
            if (c != 0) return c;
        }
        return a.compareTo(b);
    }
}
