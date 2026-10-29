#!/usr/bin/env node
// Builds the signed Remote Agent APK and publishes it next to the web app:
//   /projects/remote/public/download/remote-agent.apk   (served at /download/remote-agent.apk after `npm run build`)
//   /projects/remote/public/download/latest.json        version info
// The app itself loads https://remote.omranisystems.com/ (dashboard + /connect sharing), so web changes need no new APK;
// rebuild only when the native shell changes (bump "version" in mobile/package.json first).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = process.env.REMOTE_APK_DIR ?? resolve(root, "../public/download");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [major, minor, patch] = version.split(".").map(Number);
const versionCode = major * 10000 + minor * 100 + patch;

if (!existsSync(join(root, "android/keystore.properties"))) {
  throw new Error("android/keystore.properties is missing: the release cannot be signed.");
}

const env = { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME ?? "/opt/android-sdk" };
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, env, stdio: "inherit" });

run("npx", ["cap", "sync", "android"]);
run("./gradlew", ["--no-daemon", "-q", "assembleRelease", `-PraVersionCode=${versionCode}`, `-PraVersionName=${version}`], join(root, "android"));

const built = join(root, "android/app/build/outputs/apk/release/app-release.apk");
execFileSync(join(env.ANDROID_HOME, "build-tools/36.0.0/apksigner"), ["verify", built], { stdio: "inherit" });

mkdirSync(outDir, { recursive: true });
copyFileSync(built, join(outDir, "remote-agent.apk.tmp"));
renameSync(join(outDir, "remote-agent.apk.tmp"), join(outDir, "remote-agent.apk"));
const bytes = readFileSync(built);
writeFileSync(join(outDir, "latest.json"), JSON.stringify({
  version, versionCode, file: "remote-agent.apk", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), date: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`\nPublished remote-agent.apk ${version} (${Math.round(bytes.length / 1024)} KB) to ${outDir}`);
