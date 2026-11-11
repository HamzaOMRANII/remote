package com.omranisystems.remoteagent;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.HashSet;
import java.util.Set;

/**
 * The owner's trusted networks (M7): camera discovery only runs on a Wi-Fi the owner marked as "my network".
 * Networks are remembered by name (SSID) so a home with several access points counts as one network.
 * Android only reveals the Wi-Fi name to apps holding the location permission, with location turned on.
 */
final class HomeNetwork {
    private static final String PREFS = "remote_home_network";
    private static final String KEY = "trusted_ssids";

    /** Where this phone is right now. */
    static final class Status {
        boolean wifi;          // on Wi-Fi at all
        String ssid = "";      // "" when unknown (no permission, location off, not on Wi-Fi)
        boolean trusted;       // ssid is one of the owner's networks
        InetAddress address;   // this phone's IPv4 address on that network
        int prefix;            // its subnet prefix, e.g. 24
        boolean permission;    // location permission granted
        boolean locationOn;    // location services on (needed for the name)

        String subnetText() {
            if (address == null) return "";
            byte[] b = address.getAddress();
            int p = prefix >= 22 && prefix <= 30 ? prefix : 24;
            int ip = ((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
            int net = ip & (-1 << (32 - p));
            return ((net >>> 24) & 0xff) + "." + ((net >>> 16) & 0xff) + "." + ((net >>> 8) & 0xff) + "." + (net & 0xff) + "/" + p;
        }
    }

    static Status current(Context ctx) {
        Status s = new Status();
        s.permission = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        s.locationOn = lm != null && (Build.VERSION.SDK_INT >= 28 ? lm.isLocationEnabled() : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER));

        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return s;
        Network net = cm.getActiveNetwork();
        NetworkCapabilities caps = net == null ? null : cm.getNetworkCapabilities(net);
        s.wifi = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        if (!s.wifi) return s;
        LinkProperties lp = cm.getLinkProperties(net);
        if (lp != null) {
            for (LinkAddress la : lp.getLinkAddresses()) {
                if (la.getAddress() instanceof Inet4Address) { s.address = la.getAddress(); s.prefix = la.getPrefixLength(); break; }
            }
        }
        WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        @SuppressWarnings("deprecation")
        WifiInfo info = wm == null ? null : wm.getConnectionInfo();
        if (info != null && info.getSSID() != null) {
            String name = info.getSSID().replaceAll("^\"|\"$", "");
            if (!name.isEmpty() && !"<unknown ssid>".equals(name)) s.ssid = name;
        }
        s.trusted = !s.ssid.isEmpty() && trusted(ctx).contains(s.ssid) && s.address != null && NetworkScanner.isPrivate(s.address);
        return s;
    }

    static Set<String> trusted(Context ctx) {
        return new HashSet<>(prefs(ctx).getStringSet(KEY, new HashSet<>()));
    }

    /** Marks the current Wi-Fi as one of the owner's networks. False when its name can't be read. */
    static boolean trustCurrent(Context ctx) {
        Status s = current(ctx);
        if (s.ssid.isEmpty()) return false;
        Set<String> set = trusted(ctx);
        set.add(s.ssid);
        prefs(ctx).edit().putStringSet(KEY, set).apply();
        return true;
    }

    static void forget(Context ctx, String ssid) {
        Set<String> set = trusted(ctx);
        set.remove(ssid);
        prefs(ctx).edit().putStringSet(KEY, set).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
