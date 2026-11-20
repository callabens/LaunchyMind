import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnosticsFromFindings } from "../extensions/vscode/src/map.ts";
import { draftLabels, loadSdkBase, sdkFacts } from "../packages/labels/src/index.ts";
import { clearedBlockers, readHistory, renderDashboard, saveHistoryIfEnabled } from "../packages/history/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";
import { checkSources, emptyBaseline, normalizePage, withNewHashes } from "../packages/sources/src/index.ts";

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

async function app(directory: string): Promise<void> {
  await mkdir(join(directory, "lib"), { recursive: true });
  await mkdir(join(directory, "ios/Runner"), { recursive: true });
  await mkdir(join(directory, ".launchymind"), { recursive: true });
  await writeFile(join(directory, "pubspec.yaml"), "name: round9\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
  await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
  await writeFile(join(directory, "ios/Runner/Info.plist"), "<plist><dict></dict></plist>\n", "utf8");
}

test("verified SDK rows follow the pages that were opened", async () => {
  const base = await loadSdkBase();
  const draft = draftLabels(["unity_ads_plugin", "applovin_max", "in_app_purchase", "firebase_analytics"], base);
  const device = draft.apple.items.find((item) => item.sdk === "unity-ads" && item.type === "Device ID");
  assert.equal(device?.tracking, true);
  assert.equal(device?.source, "https://docs.unity.com/en-us/grow/ads/privacy/apple-privacy-survey");
  assert.equal(draft.play.items.some((item) => item.sdk === "unity-ads" && item.type === "Approximate location"), true);
  assert.ok(draft.unknownSdks.some((item) => item.id === "applovin" && item.reason.includes("empty NSPrivacyCollectedDataTypes")));
  assert.ok(draft.unknownSdks.some((item) => item.id === "store-billing" && item.reason.includes("collected only by Apple")));
  assert.equal(draft.apple.items.some((item) => item.sdk === "firebase-analytics" && item.type === "Device ID"), false);
  assert.equal(draft.apple.items.some((item) => item.sdk === "firebase-analytics" && item.type === "App instance ID"), true);
  const facts = sdkFacts(draftLabels(["firebase_analytics"], base), { "attestation.google.data_safety_ad_id": "no" });
  assert.equal(facts["sdk.answer_mismatch"], "not-applicable");
});

test("source check compares a stored hash and does not replace it when the page changes", async () => {
  const rules = await readFile(join(repo, "packages/packs/core/rules.yaml"));
  const before = createHash("sha256").update(rules).digest("hex");
  const url = "https://example.test/camera";
  const sources = [{ ruleId: "apple.permission-camera", url }];
  const page = "<html><body><h1>Purpose string</h1><p>One stable sentence.</p></body></html>";
  const fetchSame = async () => new Response(page, { status: 200 });
  const first = await checkSources({ sources, baseline: emptyBaseline(), fetchImpl: fetchSame, now });
  assert.equal(first.results[0]?.status, "unbaselined");
  const recorded = withNewHashes(emptyBaseline(), first, "2026-11-20");
  const same = await checkSources({ sources, baseline: recorded, fetchImpl: fetchSame, now });
  assert.equal(same.unchanged, 1);
  const fetchChanged = async () => new Response(`${page}<p>A new sentence on the page.</p>`, { status: 200 });
  const changed = await checkSources({ sources, baseline: recorded, fetchImpl: fetchChanged, now });
  assert.equal(changed.results[0]?.status, "changed");
  assert.match(changed.results[0]?.excerpt ?? "", /now "/);
  const kept = withNewHashes(recorded, changed, "2026-11-21");
  assert.equal(kept.sources[0]?.contentHash, recorded.sources[0]?.contentHash);
  const broken = await checkSources({ sources, baseline: recorded, fetchImpl: async () => new Response("missing", { status: 404 }), now });
  assert.equal(broken.results[0]?.status, "broken");
  assert.equal(normalizePage("<p>A  B</p>"), "A B");
  const after = createHash("sha256").update(await readFile(join(repo, "packages/packs/core/rules.yaml"))).digest("hex");
  assert.equal(after, before);
});

test("history is opt-in and the dashboard stays local", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-history-"));
  try {
    await app(directory);
    const quiet = await runScan(directory, { offline: true, now, env: {} });
    assert.equal(await saveHistoryIfEnabled(directory, quiet), false);
    await writeFile(join(directory, ".launchymind/project.yaml"), "history: true\n", "utf8");
    await runScan(directory, { offline: true, now, env: {} });
    await runScan(directory, { offline: true, now: new Date("2026-11-21T00:00:00Z"), env: {} });
    const entries = await readHistory(directory);
    assert.equal(entries.length, 2);
    const html = renderDashboard(entries, [{ appliedAt: "2026-11-21T00:00:00Z", ruleId: "apple.permission-camera" }]);
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("http://") || html.includes("https://"), false);
    assert.match(html, /apple.permission-camera/);
    assert.equal(clearedBlockers(entries).length >= 0, true);
    await writeFile(join(directory, ".launchymind/source-status.json"), `${JSON.stringify({ needsReverify: [{ ruleId: "apple.permission-camera", url: "https://example.test/camera", excerpt: "changed" }] })}\n`, "utf8");
    const flagged = await runScan(directory, { offline: true, now: new Date("2026-11-22T00:00:00Z"), env: {} });
    assert.equal(flagged.sourceWatch.needsReverify[0]?.ruleId, "apple.permission-camera");
    assert.equal(flagged.verdict, quiet.verdict);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sources check --offline does not fetch", async () => {
  const listed = await run(["sources", "check", "--offline"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /not run/);
});

test("editor diagnostics keep the source link and skip passing rules", () => {
  const drafts = diagnosticsFromFindings([
    { ruleId: "apple.permission-camera", title: "Camera purpose", status: "fail", severity: "blocker", summaryEn: "Missing.", sourceUrl: "https://developer.apple.com/documentation", evidence: [{ detail: "Info.plist has no key.", path: "ios/Runner/Info.plist", line: 4 }] },
    { ruleId: "store.icon", title: "Icon", status: "pass", severity: "blocker", summaryEn: "Ok.", sourceUrl: "https://example.test", evidence: [] },
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.severity, "error");
  assert.equal(drafts[0]?.path, "ios/Runner/Info.plist");
  assert.equal(drafts[0]?.sourceUrl, "https://developer.apple.com/documentation");
});
