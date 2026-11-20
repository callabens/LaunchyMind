import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runScan } from "../packages/pipeline/src/index.ts";

const repo = new URL("..", import.meta.url).pathname;
const cli = join(repo, "apps/cli/src/index.ts");
const now = new Date("2026-11-20T00:00:00Z");

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd: repo });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function app(directory: string, extra: string): Promise<void> {
  await mkdir(join(directory, "lib"), { recursive: true });
  await mkdir(join(directory, "ios/Runner"), { recursive: true });
  await mkdir(join(directory, ".launchymind"), { recursive: true });
  await writeFile(join(directory, "pubspec.yaml"), `name: labels\ndependencies:\n  flutter:\n    sdk: flutter\n${extra}`, "utf8");
  await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
  await writeFile(join(directory, "ios/Runner/Info.plist"), "<plist><dict></dict></plist>\n", "utf8");
}

test("labels drafts only verified SDK rows and a tracking mismatch is a risk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-labels-"));
  try {
    await app(directory, "  google_mobile_ads: ^5.0.0\n  unity_ads_plugin: ^0.3.0\n");
    await writeFile(join(directory, "ios/Runner/PrivacyInfo.xcprivacy"), "<plist><dict><key>NSPrivacyTracking</key><false/></dict></plist>\n", "utf8");
    const listed = await run(["labels", directory, "--json", "--offline"]);
    assert.equal(listed.code, 0, listed.stderr);
    const draft = JSON.parse(listed.stdout) as { draft: boolean; apple: { items: Array<{ sdk: string; type: string }> }; unknownSdks: Array<{ id: string }> };
    assert.equal(draft.draft, true);
    assert.ok(draft.apple.items.some((item) => item.sdk === "google-mobile-ads" && item.type === "Device ID"));
    assert.equal(draft.apple.items.some((item) => item.sdk === "unity-ads"), false);
    assert.ok(draft.unknownSdks.some((item) => item.id === "unity-ads"));
    const text = await run(["labels", directory, "--lang", "tr", "--offline"]);
    assert.match(text.stdout, /TASLAK/);
    const report = await runScan(directory, { offline: true, now, env: {} });
    assert.equal(report.findings.find((item) => item.ruleId === "sdk.manifest-label-mismatch")?.status, "fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legal packs turn on from regions and kids and withheld rules do not fail the scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-legal-"));
  try {
    await app(directory, "");
    await mkdir(join(directory, "android/app"), { recursive: true });
    await writeFile(join(directory, "android/app/build.gradle"), "android { defaultConfig { targetSdkVersion 36 } }\n", "utf8");
    await writeFile(join(directory, ".launchymind/project.yaml"), "regions: [TR, EU, US]\naudience:\n  kids: true\npacks:\n  accessibility: true\n", "utf8");
    const report = await runScan(directory, { offline: true, now, env: {} });
    assert.equal(report.findings.find((item) => item.ruleId === "legal.kvkk.consent-answered")?.status, "unchecked");
    assert.equal(report.findings.find((item) => item.ruleId === "legal.coppa.notice-answered")?.status, "unchecked");
    assert.equal(report.findings.find((item) => item.ruleId === "legal.dsa.trader-answered")?.status, "unchecked");
    assert.equal(report.findings.some((item) => item.ruleId === "legal.gdpr.notice"), false);
    assert.equal(report.findings.some((item) => item.ruleId === "legal.accessibility.basics"), false);
    assert.ok(report.withheld.some((item) => item.ruleId === "legal.gdpr.notice"));
    const plain = await mkdtemp(join(tmpdir(), "launchymind-nolegal-"));
    await app(plain, "");
    const quiet = await runScan(plain, { offline: true, now, env: {} });
    assert.equal(quiet.findings.some((item) => item.ruleId.startsWith("legal.")), false);
    await rm(plain, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a kids-directed Play app that declares AD_ID fails the Families risk rule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-families-"));
  try {
    await app(directory, "  google_mobile_ads: ^5.0.0\n");
    await mkdir(join(directory, "android/app/src/main"), { recursive: true });
    await writeFile(join(directory, "android/app/build.gradle"), "android { defaultConfig { targetSdkVersion 36 } }\n", "utf8");
    await writeFile(join(directory, "android/app/src/main/AndroidManifest.xml"), "<manifest><uses-permission android:name=\"com.google.android.gms.permission.AD_ID\"/></manifest>\n", "utf8");
    await writeFile(join(directory, ".launchymind/project.yaml"), "audience:\n  kids: true\n", "utf8");
    const report = await runScan(directory, { offline: true, now, env: {} });
    const finding = report.findings.find((item) => item.ruleId === "legal.google.families-ad-id");
    assert.equal(finding?.status, "fail");
    assert.equal(finding?.severity, "risk");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
