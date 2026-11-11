package com.omranisystems.remoteagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The owner's cameras on this phone (M7b): where their streams are and how to log in. Passwords are encrypted with
 * an AES key that lives in the Android Keystore (it can't be read or copied off the phone); the server never sees
 * them. Stored as JSON in private preferences.
 */
final class CameraStore {
    private static final String PREFS = "remote_cameras";
    private static final String KEY_ALIAS = "remote_cameras_key";

    static final class Cam {
        String id = "", name = "", ip = "", brand = "", model = "", main = "", sub = "", user = "";
        String pass = ""; // in clear only in memory
        int webPort = 0;

        /** What the web page gets: everything except the password. */
        JSONObject publicJson() throws JSONException {
            return new JSONObject().put("id", id).put("name", name).put("ip", ip).put("brand", brand).put("model", model)
                .put("main", main).put("sub", sub).put("user", user).put("webPort", webPort).put("hasSub", !sub.isEmpty());
        }

        /** rtsp://user:pass@host/path for the player (credentials URL-encoded). */
        String playUrl(boolean low) {
            String url = low && !sub.isEmpty() ? sub : main;
            if (user.isEmpty()) return url;
            try {
                String cred = java.net.URLEncoder.encode(user, "UTF-8").replace("+", "%20") + ":"
                    + java.net.URLEncoder.encode(pass, "UTF-8").replace("+", "%20") + "@";
                return url.replaceFirst("^rtsp://", "rtsp://" + cred);
            } catch (Exception e) {
                return url;
            }
        }
    }

    static List<Cam> list(Context ctx) {
        List<Cam> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(ctx).getString("cameras", "[]"));
            for (int i = 0; i < arr.length(); i++) out.add(fromJson(arr.getJSONObject(i)));
        } catch (Exception ignored) { /* unreadable list: start over rather than crash */ }
        return out;
    }

    static Cam get(Context ctx, String id) {
        for (Cam c : list(ctx)) if (c.id.equals(id)) return c;
        return null;
    }

    /** Adds or replaces (same id, or same address = the same camera). Returns the stored camera. */
    static synchronized Cam save(Context ctx, Cam cam) throws Exception {
        List<Cam> all = list(ctx);
        if (cam.id.isEmpty()) {
            for (Cam c : all) if (c.ip.equals(cam.ip)) cam.id = c.id;
            if (cam.id.isEmpty()) cam.id = UUID.randomUUID().toString().substring(0, 8);
        }
        JSONArray arr = new JSONArray();
        boolean replaced = false;
        for (Cam c : all) {
            if (c.id.equals(cam.id)) { arr.put(toJson(cam)); replaced = true; }
            else arr.put(toJson(c));
        }
        if (!replaced) arr.put(toJson(cam));
        prefs(ctx).edit().putString("cameras", arr.toString()).apply();
        return cam;
    }

    static synchronized void remove(Context ctx, String id) throws Exception {
        JSONArray arr = new JSONArray();
        for (Cam c : list(ctx)) if (!c.id.equals(id)) arr.put(toJson(c));
        prefs(ctx).edit().putString("cameras", arr.toString()).apply();
    }

    // ---- storage --------------------------------------------------------------------------------------------

    private static JSONObject toJson(Cam c) throws Exception {
        return new JSONObject().put("id", c.id).put("name", c.name).put("ip", c.ip).put("brand", c.brand).put("model", c.model)
            .put("main", c.main).put("sub", c.sub).put("user", c.user).put("webPort", c.webPort)
            .put("pass", c.pass.isEmpty() ? "" : encrypt(c.pass));
    }

    private static Cam fromJson(JSONObject o) throws Exception {
        Cam c = new Cam();
        c.id = o.optString("id"); c.name = o.optString("name"); c.ip = o.optString("ip");
        c.brand = o.optString("brand"); c.model = o.optString("model");
        c.main = o.optString("main"); c.sub = o.optString("sub"); c.user = o.optString("user");
        c.webPort = o.optInt("webPort");
        String enc = o.optString("pass");
        c.pass = enc.isEmpty() ? "" : decrypt(enc);
        return c;
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return kg.generateKey();
    }

    private static String encrypt(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        return Base64.encodeToString(all, Base64.NO_WRAP);
    }

    private static String decrypt(String enc) throws Exception {
        byte[] all = Base64.decode(enc, Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
        return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
