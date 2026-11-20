import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runScan } from "../packages/pipeline/src/index.ts";
import { syntheticPng } from "../packages/store/src/index.ts";

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

function status(report: Awaited<ReturnType<typeof runScan>>, ruleId: string): string | undefined {
  return report.findings.find((item) => item.ruleId === ruleId)?.status;
}

test("explain --why-not-ready lists only what blocks READY", async () => {
  const result = await run(["explain", join(repo, "fixtures/flutter/reject-camera"), "--why-not-ready", "--offline"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /apple\.permission-camera/);
  assert.match(result.stdout, /These items block READY/);
  assert.equal(result.stdout.includes("[pass]"), false);
  const ready = await run(["explain", join(repo, "fixtures/store/text-clean"), "--why-not-ready", "--offline", "--json"]);
  const body = JSON.parse(ready.stdout) as { blocksReady: Array<{ kind: string; ruleId: string | null }> };
  assert.equal(body.blocksReady.some((item) => item.kind === "pass"), false);
  assert.equal(body.blocksReady.some((item) => item.ruleId === "store.placeholder-text"), false);
});

test("store text fixtures keep the cited length and content checks", async () => {
  const bad = await runScan(join(repo, "fixtures/store/text-bad"), { offline: true, now });
  assert.equal(status(bad, "store.ios.name-length"), "fail");
  assert.equal(status(bad, "store.placeholder-text"), "fail");
  assert.equal(status(bad, "store.ios.other-platform"), "fail");
  assert.equal(status(bad, "store.play.other-platform"), "fail");
  assert.equal(status(bad, "store.future-promise"), "fail");
  assert.equal(status(bad, "store.copyright-year"), "fail");
  assert.equal(status(bad, "store.price-claims"), "fail");
  assert.equal(status(bad, "store.keyword-stuffing"), "fail");
  assert.equal(status(bad, "store.locale-consistency"), "fail");
  assert.equal(status(bad, "store.urls-reachable"), "unchecked");
  assert.equal(status(bad, "store.ios.screenshots"), "unchecked");

  const clean = await runScan(join(repo, "fixtures/store/text-clean"), { offline: true, now });
  assert.equal(status(clean, "store.ios.name-length"), "pass");
  assert.equal(status(clean, "store.play.title-length"), "pass");
  assert.equal(status(clean, "store.play.short-description-length"), "pass");
  assert.equal(status(clean, "store.play.full-description-length"), "pass");
  assert.equal(status(clean, "store.placeholder-text"), "pass");
  assert.equal(status(clean, "store.ios.other-platform"), "pass");
  assert.equal(status(clean, "store.price-claims"), "pass");
  assert.equal(status(clean, "store.keyword-stuffing"), "pass");
  assert.equal(status(clean, "store.locale-consistency"), "pass");
  assert.equal(status(clean, "store.copyright-year"), "pass");
  assert.equal(status(clean, "store.ios.icon"), "unchecked");
});

test("icon and screenshot sizes follow the published specs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-pixels-"));
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/ios/en-US"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/ios/screenshots"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/android/en-US"), { recursive: true });
    await mkdir(join(directory, ".launchymind/store/android/screenshots"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: pixels\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/ios/en-US/description.txt"), "A note app.\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/android/en-US/full-description.txt"), "A note app.\n", "utf8");
    await writeFile(join(directory, ".launchymind/store/ios/icon.png"), syntheticPng(64, 64, false));
    await writeFile(join(directory, ".launchymind/store/ios/screenshots/unknown.png"), syntheticPng(100, 100, false));
    await writeFile(join(directory, ".launchymind/store/android/icon.png"), syntheticPng(512, 512, true));
    await writeFile(join(directory, ".launchymind/store/android/feature-graphic.png"), syntheticPng(1024, 500, false));
    await writeFile(join(directory, ".launchymind/store/android/screenshots/one.png"), syntheticPng(1080, 1920, false));
    await writeFile(join(directory, ".launchymind/store/android/screenshots/two.png"), syntheticPng(1080, 1920, false));
    const unknown = await runScan(directory, { offline: true, now });
    assert.equal(status(unknown, "store.ios.icon"), "fail");
    assert.equal(status(unknown, "store.ios.screenshots"), "unchecked");
    assert.equal(status(unknown, "store.play.icon"), "pass");
    assert.equal(status(unknown, "store.play.feature-graphic"), "pass");
    assert.equal(status(unknown, "store.play.screenshots"), "pass");

    await writeFile(join(directory, ".launchymind/store/ios/icon.png"), syntheticPng(1024, 1024, false));
    await rm(join(directory, ".launchymind/store/ios/screenshots/unknown.png"));
    await writeFile(join(directory, ".launchymind/store/ios/screenshots/phone.png"), syntheticPng(1179, 2556, false));
    const known = await runScan(directory, { offline: true, now });
    assert.equal(status(known, "store.ios.icon"), "pass");
    assert.equal(status(known, "store.ios.screenshots"), "pass");
    await writeFile(join(directory, ".launchymind/store/ios/icon.png"), syntheticPng(1024, 1024, true));
    const alpha = await runScan(directory, { offline: true, now });
    assert.equal(status(alpha, "store.ios.icon"), "fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("regression corpus keeps the old false positives fixed", async () => {
  const cases = [
    ["guarded-sample-ad", "google.sample-ad-id", "pass"],
    ["gated-stub", "apple.stub-purchase-ui", "pass"],
    ["minimum-target", "google.target-api", "unchecked"],
    ["missing-support", "apple.support-contact", "unchecked"],
  ] as const;
  for (const [folder, ruleId, expect] of cases) {
    const report = await runScan(join(repo, "fixtures/regressions", folder), { offline: true, now });
    assert.equal(status(report, ruleId), expect, folder);
  }
});

test("npm pack dry run lists the publish files and omits tests", async () => {
  const built = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { cwd: repo, encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const jsonStart = packed.stdout.indexOf("[");
  const entries = JSON.parse(packed.stdout.slice(jsonStart)) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const entry = entries[0];
  assert.ok(entry);
  assert.match(entry.filename, /launchymind-1\.0\.0-rc\.1\.tgz/);
  const paths = entry.files.map((file) => file.path);
  assert.ok(paths.some((path) => path.endsWith("dist/apps/cli/src/index.js")));
  assert.ok(paths.some((path) => path.endsWith("packages/packs/core/rules.yaml")));
  assert.equal(paths.some((path) => path.includes("tests/")), false);
  assert.equal(paths.some((path) => path.includes(".env")), false);
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { private?: boolean; bin: { launchymind: string } };
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.bin.launchymind, "dist/apps/cli/src/index.js");
});
