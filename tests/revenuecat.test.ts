import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../packages/pipeline/src/index.ts";
import { scanProject } from "../packages/scan/src/index.ts";
import { findCorePackDir } from "../packages/core/src/index.ts";
import { readRevenueCat, readRevenueCatConfig } from "../packages/connect/src/revenuecat.ts";
import { draftLabels, loadSdkBase } from "../packages/labels/src/index.ts";

const repo = new URL("..", import.meta.url).pathname;
const now = new Date("2026-11-20T00:00:00Z");
const status = (report: Awaited<ReturnType<typeof runScan>>, id: string) => report.findings.find((item) => item.ruleId === id)?.status;

test("RevenueCat paywall with restore, terms, and renewal wording passes the paywall rules", async () => {
  const report = await runScan(join(repo, "fixtures/revenuecat/flutter-good"), { offline: true, now, env: {} });
  assert.equal(report.facts["sdk.revenuecat"], true);
  assert.equal(status(report, "apple.restore-purchases"), "pass");
  assert.equal(status(report, "apple.subscription-paywall-links"), "pass");
  assert.equal(status(report, "google.subscription-offer-terms"), "pass");
  assert.equal(status(report, "revenuecat.secret-key-in-app"), "pass");
  assert.equal(status(report, "revenuecat.products-configured"), "not_applicable");
});

test("a hardcoded RevenueCat secret key fails and is never printed", async () => {
  const report = await runScan(join(repo, "fixtures/revenuecat/flutter-bad"), { offline: true, now, env: {} });
  assert.equal(status(report, "revenuecat.secret-key-in-app"), "fail");
  assert.equal(status(report, "apple.restore-purchases"), "fail");
  assert.equal(status(report, "apple.subscription-paywall-links"), "fail");
  assert.equal(JSON.stringify(report).includes("sk_FAKEfixtureKEYnotREAL0000"), false);
});

test("RevenueCat is detected from SPM, CocoaPods, Gradle, and the Unity manifest", async () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["spm", { "App.xcodeproj/project.pbxproj": "// pbx", "App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved": JSON.stringify({ pins: [{ identity: "purchases-ios-spm", state: { version: "5.0.0" } }] }) }],
    ["pods", { "App.xcodeproj/project.pbxproj": "// pbx", "Podfile.lock": "PODS:\n  - RevenueCat (5.0.0)\n\nDEPENDENCIES:\n" }],
    ["gradle", { "app/build.gradle": "dependencies { implementation 'com.revenuecat.purchases:purchases:8.0.0' }" }],
    ["unity", { "ProjectSettings/ProjectSettings.asset": "PlayerSettings:\n  productName: Game\n", "Packages/manifest.json": JSON.stringify({ dependencies: { "com.revenuecat.purchases-unity": "7.0.0" } }) }],
  ];
  for (const [name, files] of cases) {
    const dir = await mkdtemp(join(tmpdir(), `lm-rc-${name}-`));
    try {
      for (const [path, body] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), body, "utf8");
      }
      const scanned = await scanProject(dir, findCorePackDir(), now);
      assert.equal(scanned.facts["sdk.revenuecat"], true, name);
      assert.equal(scanned.facts["capability.payments"], true, name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("RevenueCat draft rows cover App Privacy and Play Data safety", async () => {
  const draft = draftLabels(["revenuecat"], await loadSdkBase());
  assert.ok(draft.apple.items.some((item) => item.sdk === "revenuecat" && item.type === "Purchase History"));
  assert.ok(draft.play.items.some((item) => item.sdk === "revenuecat" && item.type === "Purchase history"));
});

test("connect revenuecat is read-only, compares product ids, and hides the key", async () => {
  assert.equal(readRevenueCatConfig({}), null);
  const off = await readRevenueCat(null, ["pro_monthly"], fetch, false);
  assert.equal(off.facts["connect.revenuecat"], "off");
  const seen: Array<{ url: string; method: string; auth: string }> = [];
  const mock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization") ?? "" });
    const body = url.includes("/products") ? { items: [{ id: "p1", store_identifier: "pro_monthly" }, { id: "p2", store_identifier: "pro_yearly:annual" }] }
      : url.includes("/entitlements") ? { items: [{ id: "e1" }] }
      : url.includes("/offerings") ? { items: [{ id: "o1" }] }
      : { items: [{ id: "proj1" }] };
    return new Response(JSON.stringify({ object: "list", ...body, next_page: null }), { status: 200 });
  }) as typeof fetch;
  const config = readRevenueCatConfig({ REVENUECAT_API_KEY: "sk_testsecretvalue123456" });
  const match = await readRevenueCat(config, ["pro_monthly", "pro_yearly"], mock, false);
  assert.equal(match.status, "match");
  assert.ok(seen.every((item) => item.method === "GET" && item.url.startsWith("https://api.revenuecat.com/v2/")));
  const mismatch = await readRevenueCat(config, ["pro_monthly", "lifetime"], mock, false);
  assert.equal(mismatch.status, "mismatch");
  assert.deepEqual(mismatch.missingInRevenueCat, ["lifetime"]);
  const failing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  const error = await readRevenueCat(config, [], failing, false);
  assert.equal(error.facts["connect.revenuecat"], "unknown");
  for (const result of [match, mismatch, error]) assert.equal(JSON.stringify(result).includes("sk_testsecretvalue123456"), false);
  const offline = await readRevenueCat(config, [], mock, true);
  assert.equal(offline.facts["connect.revenuecat"], "unknown");
});

test("the RevenueCat product rule stays unchecked when the API call fails", async () => {
  const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const report = await runScan(join(repo, "fixtures/revenuecat/flutter-good"), { offline: false, now, env: { REVENUECAT_API_KEY: "sk_testsecretvalue123456" }, fetchImpl: failing, liveChecker: { check: async (url: string) => ({ url, status: "http-error" as never, httpStatus: 404, placeholder: false, text: "", error: "mock" }) } });
  assert.equal(status(report, "revenuecat.products-configured"), "unchecked");
});
