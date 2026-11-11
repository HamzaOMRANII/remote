package com.omranisystems.remoteagent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks an RTSP stream address with the owner's credentials (M7b): one DESCRIBE, answering a Basic or Digest
 * challenge. Used to confirm what ONVIF reported, or — for cameras without ONVIF — to find the stream among the
 * well-known paths of the camera's brand. Only the owner's credentials are used; no password is ever guessed.
 */
final class RtspProbe {
    enum Result { OK, AUTH_FAILED, NOT_FOUND, UNREACHABLE }

    /** Main and sub stream paths by brand (first = main). The generic list is tried for unknown brands. */
    static List<String[]> knownPaths(String brand) {
        String b = brand == null ? "" : brand.toLowerCase(Locale.ROOT);
        List<String[]> out = new ArrayList<>();
        if (b.contains("hik") || b.contains("hiwatch")) out.add(new String[] { "/Streaming/Channels/101", "/Streaming/Channels/102" });
        if (b.contains("dahua") || b.contains("amcrest") || b.contains("lorex")) out.add(new String[] { "/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1" });
        if (b.contains("reolink")) out.add(new String[] { "/h264Preview_01_main", "/h264Preview_01_sub" });
        if (b.contains("tp-link") || b.contains("tapo") || b.contains("tplink")) out.add(new String[] { "/stream1", "/stream2" });
        if (b.contains("axis")) out.add(new String[] { "/axis-media/media.amp", "/axis-media/media.amp?resolution=640x360" });
        // generic, then the brand-specific ones of other brands (cheap cameras often reuse them)
        out.add(new String[] { "/stream1", "/stream2" });
        out.add(new String[] { "/Streaming/Channels/101", "/Streaming/Channels/102" });
        out.add(new String[] { "/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1" });
        out.add(new String[] { "/h264Preview_01_main", "/h264Preview_01_sub" });
        out.add(new String[] { "/live/ch00_0", "/live/ch00_1" });
        out.add(new String[] { "/11", "/12" });
        out.add(new String[] { "/live", null });
        out.add(new String[] { "/", null });
        // keep each pair once, in order
        Set<String> seen = new LinkedHashSet<>();
        List<String[]> unique = new ArrayList<>();
        for (String[] p : out) if (seen.add(p[0])) unique.add(p);
        return unique;
    }

    /** The streams found: [main, sub-or-null] as full rtsp:// addresses without credentials. */
    static final class Found {
        final String main, sub;
        Found(String main, String sub) { this.main = main; this.sub = sub; }
    }

    private final String user, pass;
    private final int timeoutMs;

    RtspProbe(String user, String pass, int timeoutMs) {
        this.user = user == null ? "" : user;
        this.pass = pass == null ? "" : pass;
        this.timeoutMs = timeoutMs;
    }

    /**
     * Finds the camera's streams on host:port. Throws OnvifClient.AuthFailed as soon as a path exists but the
     * credentials are refused (no point trying other paths with the same wrong password), IOException if none fits.
     */
    Found find(String host, int port, String brand) throws IOException {
        boolean reached = false;
        for (String[] pair : knownPaths(brand)) {
            String main = "rtsp://" + host + ":" + port + pair[0];
            Result r = describe(main);
            if (r == Result.UNREACHABLE) continue;
            reached = true;
            if (r == Result.AUTH_FAILED) throw new OnvifClient.AuthFailed();
            if (r != Result.OK) continue;
            String sub = null;
            if (pair[1] != null) {
                String s = "rtsp://" + host + ":" + port + pair[1];
                if (describe(s) == Result.OK) sub = s;
            }
            return new Found(main, sub);
        }
        throw new IOException(reached ? "The camera answers, but none of the usual stream addresses worked." : "The camera's video port doesn't answer.");
    }

    /** One DESCRIBE on `url` (rtsp://host:port/path), answering an auth challenge once. */
    Result describe(String url) {
        try {
            URI u = URI.create(url);
            int port = u.getPort() > 0 ? u.getPort() : 554;
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(u.getHost(), port), timeoutMs);
                s.setSoTimeout(timeoutMs * 3);
                String r = request(s, url, 1, null);
                int code = OnvifClient.statusCode(r);
                if (code == 401 && !user.isEmpty()) {
                    String auth = authorization(header(r, "WWW-Authenticate"), url);
                    if (auth == null) return Result.AUTH_FAILED;
                    r = request(s, url, 2, auth);
                    code = OnvifClient.statusCode(r);
                }
                if (code == 200) return Result.OK;
                if (code == 401 || code == 403) return Result.AUTH_FAILED;
                return Result.NOT_FOUND;
            }
        } catch (IOException | IllegalArgumentException e) {
            return Result.UNREACHABLE;
        }
    }

    private String request(Socket s, String url, int cseq, String auth) throws IOException {
        OutputStream out = s.getOutputStream();
        out.write(("DESCRIBE " + url + " RTSP/1.0\r\nCSeq: " + cseq + "\r\nAccept: application/sdp\r\nUser-Agent: Remote\r\n"
            + (auth == null ? "" : "Authorization: " + auth + "\r\n") + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        return readResponse(s.getInputStream());
    }

    /** Reads one RTSP response: headers, then Content-Length bytes of body. */
    private static String readResponse(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c, crlf = 0;
        while ((c = in.read()) >= 0 && sb.length() < 64_000) {
            sb.append((char) c);
            crlf = (c == '\r' || c == '\n') ? crlf + 1 : 0;
            if (crlf == 4) break;
        }
        String len = header(sb.toString(), "Content-Length");
        if (len != null) {
            int n = Math.min(Integer.parseInt(len.trim()), 64_000);
            byte[] body = new byte[n];
            int got = 0;
            while (got < n && (c = in.read(body, got, n - got)) > 0) got += c;
            sb.append(new String(body, 0, got, StandardCharsets.UTF_8));
        }
        return sb.toString();
    }

    static String header(String response, String name) {
        Matcher m = Pattern.compile("(?im)^" + Pattern.quote(name) + ":\\s*(.+?)\\s*$").matcher(response);
        return m.find() ? m.group(1) : null;
    }

    /** Builds the Authorization header for a Basic or Digest (MD5) challenge. */
    String authorization(String challenge, String url) {
        if (challenge == null) return null;
        if (challenge.regionMatches(true, 0, "Basic", 0, 5)) {
            return "Basic " + OnvifClient.b64((user + ":" + pass).getBytes(StandardCharsets.UTF_8));
        }
        if (!challenge.regionMatches(true, 0, "Digest", 0, 6)) return null;
        String realm = param(challenge, "realm"), nonce = param(challenge, "nonce");
        if (realm == null || nonce == null) return null;
        String ha1 = md5(user + ":" + realm + ":" + pass);
        String ha2 = md5("DESCRIBE:" + url);
        return "Digest username=\"" + user + "\", realm=\"" + realm + "\", nonce=\"" + nonce + "\", uri=\"" + url
            + "\", response=\"" + md5(ha1 + ":" + nonce + ":" + ha2) + "\"";
    }

    private static String param(String header, String key) {
        Matcher m = Pattern.compile(key + "=\"([^\"]*)\"").matcher(header);
        return m.find() ? m.group(1) : null;
    }

    static String md5(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
