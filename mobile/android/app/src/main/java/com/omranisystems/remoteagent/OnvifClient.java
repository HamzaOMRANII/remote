package com.omranisystems.remoteagent;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Asks an ONVIF camera for its video stream addresses (M7b), with the owner's own credentials.
 * Plain Java on raw sockets: Android's cleartext-HTTP policy doesn't apply, and it runs on any JVM for tests.
 *
 *   GetCapabilities (device service)  -> the media service address
 *   GetProfiles     (media service)   -> profile tokens (first = main stream, second = sub stream, usually)
 *   GetStreamUri    (media service)   -> rtsp://… for each profile
 *
 * Authentication: WS-Security UsernameToken with PasswordDigest = Base64(SHA1(nonce + created + password)),
 * so the password itself never travels.
 */
final class OnvifClient {
    static final class AuthFailed extends IOException { AuthFailed() { super("The camera refused this username or password."); } }

    private final String user, pass;
    private final int timeoutMs;

    OnvifClient(String user, String pass, int timeoutMs) {
        this.user = user == null ? "" : user;
        this.pass = pass == null ? "" : pass;
        this.timeoutMs = timeoutMs;
    }

    /** Stream addresses, main first. Empty if the camera answers but has no profile. */
    List<String> streamUris(String deviceServiceUrl) throws IOException {
        String caps = call(deviceServiceUrl,
            "<GetCapabilities xmlns=\"http://www.onvif.org/ver10/device/wsdl\"><Category>Media</Category></GetCapabilities>");
        String media = firstGroup(Pattern.compile("<[^>]*Media[^>]*>\\s*<[^>]*XAddr[^>]*>([^<]+)<", Pattern.DOTALL), caps);
        if (media == null) media = deviceServiceUrl; // some cameras serve media on the same address
        media = sameHost(media.trim(), deviceServiceUrl);

        String profiles = call(media, "<GetProfiles xmlns=\"http://www.onvif.org/ver10/media/wsdl\"/>");
        List<String> tokens = new ArrayList<>();
        Matcher m = Pattern.compile("<[^>]*Profiles[^>]*token=\"([^\"]+)\"").matcher(profiles);
        while (m.find() && tokens.size() < 4) tokens.add(m.group(1));

        List<String> uris = new ArrayList<>();
        for (String token : tokens) {
            String r = call(media,
                "<GetStreamUri xmlns=\"http://www.onvif.org/ver10/media/wsdl\">"
                + "<StreamSetup><Stream xmlns=\"http://www.onvif.org/ver10/schema\">RTP-Unicast</Stream>"
                + "<Transport xmlns=\"http://www.onvif.org/ver10/schema\"><Protocol>RTSP</Protocol></Transport></StreamSetup>"
                + "<ProfileToken>" + xml(token) + "</ProfileToken></GetStreamUri>");
            String uri = firstGroup(Pattern.compile("<[^>]*Uri[^>]*>([^<]+)<"), r);
            if (uri != null && uri.trim().startsWith("rtsp://")) uris.add(sameHost(uri.trim().replace("&amp;", "&"), deviceServiceUrl));
        }
        return uris;
    }

    /** Cameras behind NAT-like setups sometimes report another address: keep the one we reached. */
    static String sameHost(String reported, String reached) {
        try {
            URI r = URI.create(reported), base = URI.create(reached);
            if (r.getHost() == null || base.getHost() == null || r.getHost().equals(base.getHost())) return reported;
            return new URI(r.getScheme(), r.getUserInfo(), base.getHost(), r.getPort(), r.getPath(), r.getQuery(), null).toString();
        } catch (Exception e) {
            return reported;
        }
    }

    // ---- SOAP over HTTP/1.1 ---------------------------------------------------------------------------------

    String call(String url, String body) throws IOException {
        String envelope = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            + "<s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\"><s:Header>" + security() + "</s:Header>"
            + "<s:Body>" + body + "</s:Body></s:Envelope>";
        URI u = URI.create(url);
        if (!"http".equalsIgnoreCase(u.getScheme())) throw new IOException("Only http ONVIF addresses are supported: " + url);
        int port = u.getPort() > 0 ? u.getPort() : 80;
        String path = (u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath()) + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
        byte[] payload = envelope.getBytes(StandardCharsets.UTF_8);
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(u.getHost(), port), timeoutMs);
            s.setSoTimeout(timeoutMs * 3);
            OutputStream out = s.getOutputStream();
            out.write(("POST " + path + " HTTP/1.1\r\nHost: " + u.getHost() + ":" + port
                + "\r\nContent-Type: application/soap+xml; charset=utf-8\r\nContent-Length: " + payload.length
                + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(payload);
            out.flush();
            String response = readAll(s.getInputStream());
            int code = statusCode(response);
            if (code == 401 || response.contains("NotAuthorized") || response.contains("FailedAuthentication")) throw new AuthFailed();
            if (code != 200) throw new IOException("The camera answered HTTP " + code + ".");
            return response;
        }
    }

    private String security() {
        if (user.isEmpty()) return "";
        byte[] nonce = new byte[16];
        new SecureRandom().nextBytes(nonce);
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        String created = f.format(new Date());
        String digest;
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update(nonce);
            sha1.update(created.getBytes(StandardCharsets.UTF_8));
            sha1.update(pass.getBytes(StandardCharsets.UTF_8));
            digest = b64(sha1.digest());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return "<Security s:mustUnderstand=\"1\" xmlns=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\">"
            + "<UsernameToken><Username>" + xml(user) + "</Username>"
            + "<Password Type=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest\">" + digest + "</Password>"
            + "<Nonce EncodingType=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary\">"
            + b64(nonce) + "</Nonce>"
            + "<Created xmlns=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\">" + created + "</Created>"
            + "</UsernameToken></Security>";
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0 && b.size() < 2_000_000) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }

    static int statusCode(String response) {
        Matcher m = Pattern.compile("^(?:HTTP|RTSP)/\\d\\.\\d (\\d{3})").matcher(response);
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }

    private static String firstGroup(Pattern p, String s) {
        Matcher m = p.matcher(s);
        return m.find() ? m.group(1) : null;
    }

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    /** Standard Base64 (java.util.Base64 needs Android 8; the app supports Android 7). */
    static String b64(byte[] d) {
        StringBuilder sb = new StringBuilder((d.length + 2) / 3 * 4);
        for (int i = 0; i < d.length; i += 3) {
            int b = (d[i] & 0xff) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xff) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xff : 0);
            sb.append(B64[b >>> 18 & 63]).append(B64[b >>> 12 & 63]);
            sb.append(i + 1 < d.length ? B64[b >>> 6 & 63] : '=').append(i + 2 < d.length ? B64[b & 63] : '=');
        }
        return sb.toString();
    }

    static String xml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
