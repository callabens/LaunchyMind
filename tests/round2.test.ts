import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotFlutterProjectError } from "../packages/core/src/index.ts";
import { inspectPage } from "../packages/live/src/index.ts";
import { scriptedChecker } from "../packages/live/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";
import { scanProject } from "../packages/scan/src/index.ts";
import { findCorePackDir } from "../packages/core/src/index.ts";

const repo = new URL("..", import.meta.url).pathname;
const now = new Date("2026-11-19T00:00:00Z");

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(repo, "apps/cli/src/index.ts"), ...args], { cwd: repo });
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

test("consent headings in English and Turkish count, and the evidence is not the nav", async () => {
  const html = await readFile(join(repo, "fixtures/policy/bilingual-privacy.html"), "utf8");
  const report = inspectPage(html, ["Sample Game"]);
  assert.equal(report.signals.consent, "yes");
  assert.equal(report.signals.notForChildren, "yes");
  assert.match(report.snippet, /Withdrawing Consent|Rızanızı Geri Alma/);
  assert.equal(report.summary.includes("Missing withdrawing consent"), false);
});

test("a privacy host is enough for support and app-ads checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-infer-"));
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: ads_app\ndependencies:\n  flutter:\n    sdk: flutter\n  google_mobile_ads: ^5.0.0\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "const privacyPolicyUrl = 'http://127.0.0.1:9/privacy';\nvoid main() {}\n", "utf8");
    await writeFile(join(directory, "ios/Runner/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>NSUserTrackingUsageDescription</key><string>Ads</string>
</dict></plist>
`, "utf8");
    const checker = scriptedChecker({
      "http://127.0.0.1:9/privacy": { status: 200, body: await readFile(join(repo, "fixtures/policy/bilingual-privacy.html"), "utf8") },
      "http://127.0.0.1:9/support": { status: 200, body: "<p>Contact us at help@example.com</p>" },
      "http://127.0.0.1:9/app-ads.txt": { status: 200, body: "google.com, pub-1, DIRECT, f08c47fec0942fa0" },
    });
    const report = await runScan(directory, { now, liveChecker: checker });
    assert.equal(report.facts["urls.support.present"], true);
    assert.equal(report.facts["live.app_ads.status"], "ok");
    assert.equal(report.facts["live.privacy.consent"], "yes");
    const privacyEvidence = report.findings.find((finding) => finding.ruleId === "apple.privacy-policy-content")?.evidence ?? [];
    assert.equal(privacyEvidence.some((item) => item.snippet?.includes("Withdrawing Consent") || item.detail.includes("Found")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flutter.targetSdkVersion uses the SDK default table and says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-sdk-"));
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "android/app"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: sdk_app\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
    await writeFile(join(directory, "pubspec.lock"), "sdks:\n  flutter: \">=3.35.0\"\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(join(directory, "android/app/build.gradle"), "android {\n  defaultConfig {\n    targetSdk = flutter.targetSdkVersion\n    minSdk = flutter.minSdkVersion\n  }\n}\n", "utf8");
    const scanned = await scanProject(directory, findCorePackDir());
    assert.equal(scanned.facts["android.target_sdk"], 36);
    assert.equal(scanned.facts["android.min_sdk"], 24);
    assert.equal(scanned.facts["android.target_sdk_basis"], "flutter-sdk-minimum");
    assert.match(scanned.evidence.map((item) => item.detail).join("\n"), /Flutter SDK default table/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tracking manifest mismatch and sample ad id and stub purchase are visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-manifest-"));
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: track_app\ndependencies:\n  flutter:\n    sdk: flutter\n  google_mobile_ads: ^5.0.0\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "const purchase = 'Store purchase is stubbed in this build';\nconst id = 'ca-app-pub-3940256099942544~1';\n", "utf8");
    await writeFile(join(directory, "ios/Runner/Info.plist"), "<plist><dict></dict></plist>\n", "utf8");
    await writeFile(join(directory, "ios/Runner/PrivacyInfo.xcprivacy"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>NSPrivacyTracking</key><false/>
<key>NSPrivacyTrackingDomains</key><array></array>
<key>NSPrivacyCollectedDataTypes</key><array><dict>
<key>NSPrivacyCollectedDataTypeTracking</key><true/>
</dict></array>
</dict></plist>
`, "utf8");
    const report = await runScan(directory, { offline: true, now });
    assert.equal(report.findings.find((item) => item.ruleId === "apple.privacy-manifest-tracking")?.status, "fail");
    assert.equal(report.findings.find((item) => item.ruleId === "google.sample-ad-id")?.status, "fail");
    assert.equal(report.findings.find((item) => item.ruleId === "google.ump-consent-call")?.status, "fail");
    assert.equal(report.findings.find((item) => item.ruleId === "apple.stub-purchase-ui")?.status, "fail");
    assert.equal(report.observations.some((item) => item.id.startsWith("package.unrecognized.")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only a missing privacy link is labeled not ready, and a non-Flutter folder is a usage error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-link-"));
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await mkdir(join(directory, "android/app"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: quiet\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(join(directory, "ios/Runner/Info.plist"), "<plist><dict><key>CFBundleDisplayName</key><string>Quiet</string></dict></plist>\n", "utf8");
    await writeFile(join(directory, "android/app/build.gradle"), "android { defaultConfig { targetSdk = 36 } }\n", "utf8");
    const report = await runScan(directory, { offline: true, now });
    assert.equal(report.verdict, "reject");
    assert.equal(report.verdictHeadline, "NOT READY");
    assert.match(report.verdictBecause.join(" "), /one missing link|no privacy policy link/i);
    assert.equal(report.verdictBecause.join(" ").includes("apple.privacy-policy-in-app failed"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const empty = await mkdtemp(join(tmpdir(), "launchymind-empty-"));
  try {
    await assert.rejects(runScan(empty, { offline: true, now }), NotFlutterProjectError);
    const cli = await run(["scan", empty, "--offline"]);
    assert.equal(cli.code, 4);
    assert.match(cli.stderr, /Not a Flutter project/);
    const output = join(empty, "out.json");
    const dumped = await run(["scan", join(repo, "fixtures/flutter/risky-accounts"), "--offline", "--json", "--output", output]);
    assert.equal(dumped.stdout.trim().startsWith("{"), false);
    assert.equal((await readFile(output, "utf8")).trim().startsWith("{"), true);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
