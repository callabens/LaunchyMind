import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeBinaryXml, encodePlist, encodeProtoManifest, zipFiles } from "../packages/artifact/src/index.ts";
import { readConnect } from "../packages/connect/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";
import { syntheticPng } from "../packages/store/src/index.ts";

const now = new Date("2026-11-20T00:00:00Z");

function status(report: Awaited<ReturnType<typeof runScan>>, ruleId: string): string | undefined {
  return report.findings.find((item) => item.ruleId === ruleId)?.status;
}

async function flutterApp(directory: string): Promise<void> {
  await mkdir(join(directory, "lib"), { recursive: true });
  await writeFile(join(directory, "pubspec.yaml"), "name: round7\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
  await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
}

test("an iPad-only project accepts a 13-inch screenshot and an unknown family does not fail it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-ipad-"));
  try {
    await flutterApp(directory);
    await mkdir(join(directory, "ios/Runner.xcodeproj"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/ios/en-US"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/ios/ipad"), { recursive: true });
    await writeFile(join(directory, "ios/Runner.xcodeproj/project.pbxproj"), "TARGETED_DEVICE_FAMILY = \"2\";\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/ios/en-US/description.txt"), "A note app.\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/ios/ipad/shot.png"), syntheticPng(2048, 2732, false));
    const ipad = await runScan(directory, { offline: true, now, env: {} });
    assert.equal(ipad.facts["ios.device_family"], "ipad");
    assert.equal(status(ipad, "store.ios.screenshots"), "pass");
    await rm(join(directory, "ios/Runner.xcodeproj/project.pbxproj"));
    const unknown = await runScan(directory, { offline: true, now, env: {} });
    assert.equal(unknown.facts["ios.device_family"], "unknown");
    assert.equal(status(unknown, "store.ios.screenshots"), "unchecked");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Play icon over 1024 KB fails and a past copyright year does not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-icon-"));
  try {
    await flutterApp(directory);
    await mkdir(join(directory, ".launchymind/store/android/en-US"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/ios/en-US"), { recursive: true });
    await writeFile(join(directory, ".launchymind/store/android/en-US/title.txt"), "Notes\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/ios/en-US/copyright.txt"), "Copyright 2014 Example\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/ios/en-US/description.txt"), "A note app.\n", "utf8");
    const icon = Buffer.concat([syntheticPng(512, 512, true), Buffer.alloc(1024 * 1024)]);
    await writeFile(join(directory, ".launchymind/store/android/icon.png"), icon);
    const report = await runScan(directory, { offline: true, now, env: {} });
    assert.equal(status(report, "store.play.icon"), "fail");
    assert.equal(status(report, "store.copyright-year"), "pass");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connect reads mocked store APIs and does not reveal keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-connect-"));
  const apple = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const google = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const applePath = join(directory, "AuthKey.p8");
  const googlePath = join(directory, "play.json");
  await writeFile(applePath, apple, "utf8");
  await writeFile(googlePath, JSON.stringify({ client_email: "play@example.iam.gserviceaccount.com", private_key: google, token_uri: "https://oauth2.googleapis.com/token" }), "utf8");
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const header = new Headers(init?.headers).get("authorization") ?? "";
    assert.equal(header.includes("PRIVATE"), false);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("oauth2.googleapis.com")) return json({ access_token: "token" });
    if (url.endsWith("/apps?limit=20")) return json({ data: [{ id: "app1", attributes: { bundleId: "dev.example.app" } }] });
    if (url.includes("appInfos")) return json({ data: [], included: [{ attributes: { privacyPolicyUrl: "https://example.com/privacy" } }] });
    if (url.includes("appStoreVersions")) return json({ data: [], included: [{ attributes: { supportUrl: "https://example.com/support" } }] });
    if (url.includes("ageRatingDeclaration")) return json({ data: { id: "age", attributes: { advertising: false } } });
    if (url.includes("/builds?")) return json({ data: [{ id: "build", attributes: { minOsVersion: "16.0", version: "1" } }] });
    if (url.endsWith("/edits") && (init?.method ?? "GET") === "POST") return json({ id: "edit1" });
    if (url.endsWith("/tracks")) return json({ tracks: [{ track: "internal", releases: [{ status: "completed" }] }] });
    if ((init?.method ?? "") === "DELETE") return new Response("", { status: 204 });
    return new Response("missing", { status: 404 });
  };
  try {
    const report = await readConnect({
      apple: { keyId: "KEYID", issuerId: "ISSUER", keyPath: applePath, bundleId: "dev.example.app" },
      google: { jsonPath: googlePath, packageName: "dev.example.app" },
    }, fetchImpl, false);
    const text = report.lines.join("\n");
    assert.equal(text.includes("PRIVATE KEY"), false);
    assert.equal(text.includes(google), false);
    assert.match(text, /Data safety/);
    assert.match(text, /Xcode/);
    assert.equal(report.facts["attestation.apple.age_rating"], "yes");
    assert.equal(report.facts["urls.support.present"], true);
    assert.equal(report.facts["google.distribution"], "internal-only");
    assert.equal(report.facts["ios.deployment_target"], 16);
    assert.equal(seen.some((line) => line.startsWith("DELETE")), true);
    assert.equal(seen.some((line) => line.includes("dataSafety")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact scan reads a synthetic IPA, APK, and AAB and flags targetSdk drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-artifact-"));
  try {
    await flutterApp(directory);
    await mkdir(join(directory, "android/app"), { recursive: true });
    await writeFile(join(directory, "android/app/build.gradle"), "android { defaultConfig { targetSdkVersion 36 } }\n", "utf8");
    const plist = encodePlist({ NSCameraUsageDescription: "Take a photo for a note." });
    const ipa = zipFiles([
      { name: "Payload/Demo.app/Info.plist", data: plist },
      { name: "Payload/Demo.app/PrivacyInfo.xcprivacy", data: Buffer.from("<plist><dict><key>NSPrivacyTracking</key><false/></dict></plist>") },
      { name: "Payload/Demo.app/Frameworks/Flutter.framework/PrivacyInfo.xcprivacy", data: Buffer.from("<plist><dict></dict></plist>") },
      { name: "Payload/Demo.app/embedded.mobileprovision", data: Buffer.from("<?xml version=\"1.0\"?><plist><dict><key>Entitlements</key><dict></dict></dict></plist>") },
    ]);
    const apk = zipFiles([{ name: "AndroidManifest.xml", data: encodeBinaryXml(34, ["com.google.android.gms.permission.AD_ID"]) }]);
    const aab = zipFiles([{ name: "base/manifest/AndroidManifest.xml", data: encodeProtoManifest(34, []) }]);
    await writeFile(join(directory, "app.ipa"), ipa);
    await writeFile(join(directory, "app.apk"), apk);
    await writeFile(join(directory, "app.aab"), aab);
    const compared = await runScan(directory, { offline: true, now, env: {}, artifactPath: join(directory, "app.apk") });
    assert.equal(compared.facts["artifact.drift"], "yes", String(compared.facts["android.target_sdk"]));
    const drift = compared.findings.find((item) => item.ruleId === "artifact.drift");
    assert.match(drift?.evidence.map((item) => item.detail).join("\n") ?? "", /targetSdk source 36 artifact 34/);
    const { runArtifactOnly } = await import("../packages/pipeline/src/index.ts");
    const alone = await runArtifactOnly(join(directory, "app.ipa"), { offline: true, now });
    assert.equal(alone.facts["ios.usage.camera"], true);
    assert.equal(alone.facts["framework.flutter"], true);
    assert.equal(alone.facts["ios.privacy_manifest.tracking"], "false");
    const proto = await runArtifactOnly(join(directory, "app.aab"), { offline: true, now });
    assert.equal(proto.facts["android.target_sdk"], 34);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
