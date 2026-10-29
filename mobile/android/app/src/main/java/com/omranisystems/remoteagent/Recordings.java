package com.omranisystems.remoteagent;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Log;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Where recordings live: on this phone only (nothing is uploaded to the server).
 *   Android 10+   the gallery, Movies/Remote (visible in Photos / Files, survives uninstalling the app)
 *   Android 7-9   the app's own Movies folder (no storage permission needed; removed with the app)
 * The list (name, length, size, the cloud link the user pasted after sharing it to Drive…) is kept in the app's
 * preferences.
 */
final class Recordings {
    private static final String TAG = "RemoteRecordings";
    private static final String PREFS = "remote_recordings";

    /** One MP4 being written. */
    static final class Out {
        final MediaMuxer muxer;
        final String name, session;
        final int part;
        final long started = System.currentTimeMillis();
        final Uri uri;                 // Android 10+
        final ParcelFileDescriptor pfd; // Android 10+
        final File file;               // Android 7-9

        Out(MediaMuxer muxer, String name, String session, int part, Uri uri, ParcelFileDescriptor pfd, File file) {
            this.muxer = muxer; this.name = name; this.session = session; this.part = part;
            this.uri = uri; this.pfd = pfd; this.file = file;
        }
    }

    private Recordings() {}

    static Out create(Context ctx, String name, String session, int part) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Video.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            v.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Remote");
            v.put(MediaStore.Video.Media.IS_PENDING, 1); // hidden from other apps until the file is complete
            Uri uri = ctx.getContentResolver().insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (uri == null) throw new IOException("could not create the video file");
            ParcelFileDescriptor pfd = ctx.getContentResolver().openFileDescriptor(uri, "rw");
            if (pfd == null) throw new IOException("could not open the video file");
            try {
                return new Out(new MediaMuxer(pfd.getFileDescriptor(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4), name, session, part, uri, pfd, null);
            } catch (IOException e) {
                pfd.close();
                ctx.getContentResolver().delete(uri, null, null);
                throw e;
            }
        }
        File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES), "Remote");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no storage available");
        File f = new File(dir, name);
        return new Out(new MediaMuxer(f.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4), name, session, part, null, null, f);
    }

    /** Closes the file; keeps it (and lists it) only if it holds video. */
    static void finish(Context ctx, Out o, long durationMs, boolean wroteSamples) {
        boolean ok = wroteSamples;
        try { if (wroteSamples) o.muxer.stop(); } catch (Throwable t) { ok = false; Log.w(TAG, "muxer stop", t); }
        try { o.muxer.release(); } catch (Throwable ignored) {}
        long size = 0;
        try {
            if (o.pfd != null) { size = o.pfd.getStatSize(); o.pfd.close(); }
            else if (o.file != null) size = o.file.length();
        } catch (Throwable ignored) {}
        try {
            if (!ok) {
                if (o.uri != null) ctx.getContentResolver().delete(o.uri, null, null);
                else if (o.file != null) //noinspection ResultOfMethodCallIgnored
                    o.file.delete();
                return;
            }
            if (o.uri != null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Video.Media.IS_PENDING, 0);
                ctx.getContentResolver().update(o.uri, v, null, null);
            }
            JSONObject item = new JSONObject()
                .put("id", o.session + (o.part > 1 ? "-" + o.part : ""))
                .put("name", o.name)
                .put("where", o.uri != null ? o.uri.toString() : o.file.getAbsolutePath())
                .put("started", o.started)
                .put("duration", durationMs)
                .put("size", size)
                .put("session", o.session)
                .put("part", o.part)
                .put("link", "");
            synchronized (Recordings.class) {
                JSONArray all = load(ctx);
                all.put(item);
                save(ctx, all);
            }
        } catch (Throwable t) { Log.w(TAG, "finish", t); }
    }

    // ---- the list ---------------------------------------------------------------------------------------------

    private static JSONArray load(Context ctx) {
        try { return new JSONArray(prefs(ctx).getString("items", "[]")); }
        catch (Exception e) { return new JSONArray(); }
    }

    private static void save(Context ctx, JSONArray all) {
        prefs(ctx).edit().putString("items", all.toString()).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Newest first, each with "exists" (false once deleted from the gallery). */
    static synchronized JSONArray list(Context ctx) {
        JSONArray all = load(ctx), out = new JSONArray();
        for (int i = all.length() - 1; i >= 0; i--) {
            JSONObject it = all.optJSONObject(i);
            if (it == null) continue;
            try {
                JSONObject copy = new JSONObject(it.toString());
                copy.remove("where");
                copy.put("exists", exists(ctx, it));
                out.put(copy);
            } catch (Exception ignored) {}
        }
        return out;
    }

    static synchronized JSONObject find(Context ctx, String id) {
        JSONArray all = load(ctx);
        for (int i = 0; i < all.length(); i++) {
            JSONObject it = all.optJSONObject(i);
            if (it != null && id.equals(it.optString("id"))) return it;
        }
        return null;
    }

    static synchronized void setLink(Context ctx, String id, String link) {
        JSONArray all = load(ctx);
        for (int i = 0; i < all.length(); i++) {
            JSONObject it = all.optJSONObject(i);
            if (it != null && id.equals(it.optString("id"))) {
                try { it.put("link", link == null ? "" : link.trim()); } catch (Exception ignored) {}
            }
        }
        save(ctx, all);
    }

    /** Deletes the file and its entry. Returns false if Android kept the file (e.g. after reinstalling the app). */
    static synchronized boolean delete(Context ctx, String id) {
        JSONArray all = load(ctx), keep = new JSONArray();
        boolean fileGone = true;
        for (int i = 0; i < all.length(); i++) {
            JSONObject it = all.optJSONObject(i);
            if (it == null) continue;
            if (!id.equals(it.optString("id"))) { keep.put(it); continue; }
            String where = it.optString("where");
            try {
                if (where.startsWith("content:")) ctx.getContentResolver().delete(Uri.parse(where), null, null);
                else //noinspection ResultOfMethodCallIgnored
                    new File(where).delete();
            } catch (Throwable t) {
                fileGone = !exists(ctx, it); // not ours any more: leave it in the gallery, drop it from the list
            }
        }
        save(ctx, keep);
        return fileGone;
    }

    /** A content:// URI another app (player, Drive, WhatsApp…) can read. */
    static Uri shareUri(Context ctx, JSONObject it) {
        String where = it.optString("where");
        if (where.startsWith("content:")) return Uri.parse(where);
        return FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", new File(where));
    }

    private static boolean exists(Context ctx, JSONObject it) {
        String where = it.optString("where");
        if (!where.startsWith("content:")) return new File(where).exists();
        try (Cursor c = ctx.getContentResolver().query(Uri.parse(where), new String[] { MediaStore.Video.Media._ID }, null, null, null)) {
            return c != null && c.getCount() > 0;
        } catch (Throwable t) {
            return false;
        }
    }
}
