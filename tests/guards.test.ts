import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubPurchaseState, unguardedSampleIds } from "../packages/scan/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";

const SAMPLE = "ca-app-pub-3940256099942544/111";
const REAL = "ca-app-pub-2828327093104652/222";

test("release-guarded sample ad ids are not treated as shipped", () => {
  const samples = [
    `final id = kReleaseMode ? '${REAL}' : '${SAMPLE}';`,
    `final id = kReleaseMode\n    ? '${REAL}'\n    : '${SAMPLE}';`,
    `final id = !kReleaseMode ? '${SAMPLE}' : '${REAL}';`,
    `final id = kDebugMode ? '${SAMPLE}' : '${REAL}';`,
    `final id = !kDebugMode ? '${REAL}' : '${SAMPLE}';`,
    `if (kReleaseMode) { id = '${REAL}'; } else { id = '${SAMPLE}'; }`,
    `if (!kReleaseMode) { id = '${SAMPLE}'; } else { id = '${REAL}'; }`,
    `if (kDebugMode) {\n  id = '${SAMPLE}';\n} else {\n  id = '${REAL}';\n}`,
  ];
  for (const source of samples) {
    assert.deepEqual(unguardedSampleIds(source), [], source);
  }
  assert.equal(unguardedSampleIds(`final id = kReleaseMode ? '${SAMPLE}' : '${REAL}';`).length, 1);
  assert.equal(unguardedSampleIds(`final id = kDebugMode ? '${REAL}' : '${SAMPLE}';`).length, 1);
  assert.equal(unguardedSampleIds(`if (kReleaseMode) { id = '${SAMPLE}'; } else { id = '${REAL}'; }`).length, 1);
  assert.equal(unguardedSampleIds(`const id = '${SAMPLE}';`).length, 1);
});

test("a const false flag makes stub purchase text an observation", () => {
  const gated = `
const kRemoveAdsEnabled = false;
class Settings {
  Widget build() {
    if (kRemoveAdsEnabled) {
      return Text('Store purchase is stubbed in this build');
    }
    return Text('Settings');
  }
}
`;
  assert.equal(stubPurchaseState([gated], false), "gated");
  const reachable = `
class Settings {
  Widget build() {
    return Text('Store purchase is stubbed in this build');
  }
}
`;
  assert.equal(stubPurchaseState([reachable], false), "reachable");
  assert.equal(stubPurchaseState([gated], true), "absent");
});

test("synthetic tracking-mismatch fixture matches the round-2 pattern", async () => {
  const root = new URL("../fixtures/flutter/tracking-mismatch/", import.meta.url).pathname;
  const report = await runScan(root, { offline: true, now: new Date("2026-11-19T00:00:00Z") });
  assert.equal(report.findings.find((item) => item.ruleId === "apple.privacy-manifest-tracking")?.status, "fail");
  assert.equal(report.findings.find((item) => item.ruleId === "google.sample-ad-id")?.status, "pass");
  assert.equal(report.findings.find((item) => item.ruleId === "google.ump-consent-call")?.status, "pass");
  assert.equal(report.findings.find((item) => item.ruleId === "apple.listed-sdk-manifest")?.status, "pass");
  assert.equal(report.findings.find((item) => item.ruleId === "google.ad-id-permission")?.status, "pass");
  assert.equal(report.facts["capability.game_center"], true);
  assert.equal(report.facts["capability.play_games"], true);
  const html = (await import("../packages/report/src/index.ts")).renderHtml(report);
  assert.match(html, /<h3>Ads or tracking should match the privacy manifest tracking fields<\/h3>/);
  assert.equal(html.includes("<h3>apple.privacy-manifest-tracking</h3>"), false);

  const directory = await mkdtemp(join(tmpdir(), "launchymind-path-"));
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: paths\ndependencies:\n  flutter:\n    sdk: flutter\n  path_provider: ^2.1.0\n", "utf8");
    await writeFile(join(directory, "pubspec.lock"), "packages:\n  path_provider:\n    version: \"2.1.0\"\nsdks:\n  flutter: \">=3.16.0\"\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(join(directory, "ios/Runner/Info.plist"), "<plist><dict></dict></plist>\n", "utf8");
    const pathReport = await runScan(directory, { offline: true, now: new Date("2026-11-19T00:00:00Z") });
    const listed = pathReport.findings.find((item) => item.ruleId === "apple.listed-sdk-manifest");
    assert.equal(listed?.status, "unchecked");
    assert.match(listed?.checkNote ?? "", /2\.6\.0/);
    assert.match(listed?.evidence.map((item) => item.detail).join("\n") ?? "", /path_provider_foundation/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
