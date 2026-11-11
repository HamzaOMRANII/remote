package com.omranisystems.remoteagent;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Checks NetworkScanner against camlab.py (run both inside the "camlab" network namespace). Exit 1 on failure. */
public class NetworkScannerCheck {
    static int failures = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) failures++; }

    public static void main(String[] args) throws Exception {
        InetAddress self = InetAddress.getByName("10.77.0.2");
        List<InetAddress> targets = NetworkScanner.subnet(self, 24);
        check(targets.size() == 253, "a /24 gives 253 addresses without itself (" + targets.size() + ")");
        check(NetworkScanner.subnet(InetAddress.getByName("8.8.8.8"), 24).isEmpty(), "public addresses are never scanned");
        check(NetworkScanner.subnet(InetAddress.getByName("192.168.1.5"), 16).size() == 253, "a /16 is reduced to the /24");

        AtomicInteger updates = new AtomicInteger();
        long t0 = System.currentTimeMillis();
        List<NetworkScanner.Host> hosts = new NetworkScanner(400, 128)
            .scan(targets, new InetSocketAddress("10.77.0.10", 3702), h -> updates.incrementAndGet());
        long ms = System.currentTimeMillis() - t0;
        for (NetworkScanner.Host h : hosts)
            System.out.println("     " + h.ip + " " + h.kind() + " ports=" + h.ports + " " + h.manufacturer + " " + h.model + " " + h.onvifAddress);

        check(hosts.size() == 3, "3 devices found (" + hosts.size() + ")");
        NetworkScanner.Host hik = hosts.stream().filter(h -> h.ip.equals("10.77.0.10")).findFirst().orElse(null);
        check(hik != null && hik.kind().equals("camera"), "10.77.0.10 is a camera");
        check(hik != null && hik.ports.contains(554) && hik.ports.contains(80), "10.77.0.10 has RTSP 554 and web 80");
        check(hik != null && hik.manufacturer.equals("HIKVISION") && hik.model.equals("DS-2CD2143G0-I"), "ONVIF brand and model read");
        check(hik != null && hik.onvifAddress.equals("http://10.77.0.10/onvif/device_service"), "ONVIF service address read");
        NetworkScanner.Host dahua = hosts.stream().filter(h -> h.ip.equals("10.77.0.11")).findFirst().orElse(null);
        check(dahua != null && dahua.kind().equals("camera") && dahua.ports.contains(37777), "37777 counts as a camera (Dahua)");
        NetworkScanner.Host router = hosts.stream().filter(h -> h.ip.equals("10.77.0.12")).findFirst().orElse(null);
        check(router != null && router.kind().equals("maybe"), "a web-only device is 'maybe'");
        check(updates.get() >= 6, "progress updates while scanning (" + updates.get() + ")");
        check(ms < 9000, "a /24 scan takes under 9 s (" + ms + " ms)");
        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
