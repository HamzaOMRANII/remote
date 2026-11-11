package com.omranisystems.remoteagent;

import java.util.List;

/** Checks OnvifClient + RtspProbe against camlab.py (both inside the "camlab" namespace). Exit 1 on failure. */
public class CameraAccessCheck {
    static int failures = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) failures++; }

    public static void main(String[] args) throws Exception {
        String service = "http://10.77.0.10/onvif/device_service";

        List<String> uris = new OnvifClient("admin", "Cam-Pass-123", 1500).streamUris(service);
        System.out.println("     ONVIF streams: " + uris);
        check(uris.size() == 2, "ONVIF gives the main and sub streams");
        check(uris.size() > 0 && uris.get(0).equals("rtsp://10.77.0.10:554/Streaming/Channels/101"), "main stream address");

        boolean refused = false;
        try { new OnvifClient("admin", "wrong-password", 1500).streamUris(service); }
        catch (OnvifClient.AuthFailed e) { refused = true; }
        check(refused, "ONVIF refuses a wrong password (reported as such)");

        RtspProbe probe = new RtspProbe("admin", "Cam-Pass-123", 1500);
        check(probe.describe("rtsp://10.77.0.10:554/Streaming/Channels/101") == RtspProbe.Result.OK, "RTSP Digest login accepted");
        check(new RtspProbe("admin", "nope", 1500).describe("rtsp://10.77.0.10:554/Streaming/Channels/101") == RtspProbe.Result.AUTH_FAILED,
            "RTSP wrong password = AUTH_FAILED");
        check(probe.describe("rtsp://10.77.0.10:554/does-not-exist") == RtspProbe.Result.NOT_FOUND, "unknown path = NOT_FOUND");
        check(probe.describe("rtsp://10.77.0.12:554/x") == RtspProbe.Result.UNREACHABLE, "closed port = UNREACHABLE");

        // No ONVIF: the Dahua-like camera's stream is found among the known paths (generic list, brand unknown)
        RtspProbe.Found f = probe.find("10.77.0.11", 554, "");
        System.out.println("     found without ONVIF: " + f.main + " | " + f.sub);
        check(f.main.equals("rtsp://10.77.0.11:554/cam/realmonitor?channel=1&subtype=0"), "main stream found without ONVIF");
        check("rtsp://10.77.0.11:554/cam/realmonitor?channel=1&subtype=1".equals(f.sub), "sub stream found without ONVIF");

        boolean stopped = false;
        try { new RtspProbe("admin", "nope", 1500).find("10.77.0.11", 554, "dahua"); }
        catch (OnvifClient.AuthFailed e) { stopped = true; }
        check(stopped, "a wrong password stops the search at once (no guessing on other paths)");

        check(OnvifClient.b64("Man".getBytes()).equals("TWFu") && OnvifClient.b64("Ma".getBytes()).equals("TWE=")
            && OnvifClient.b64("M".getBytes()).equals("TQ=="), "Base64 encoder");
        check(OnvifClient.sameHost("rtsp://192.168.0.64:554/a", "http://10.77.0.10/onvif").equals("rtsp://10.77.0.10:554/a"),
            "a camera reporting another address is reached on the one we used");
        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
