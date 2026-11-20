import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBinaryXml, encodePlist, zipFiles } from "../packages/artifact/src/index.ts";
import { type BuildRunner } from "../packages/build/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";

const repo = new URL("..", import.meta.url).pathname;
const now = new Date("2026-11-20T00:00:00Z");
const status = (report: Awaited<ReturnType<typeof runScan>>, id: string) => report.findings.find((item) => item.ruleId === id)?.status;

async function copyFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lm-build-"));
  await cp(join(repo, "fixtures/revenuecat/flutter-good"), dir, { recursive: true });
  return dir;
}

test("without a toolchain --build leaves the build rule unchecked, never a pass", async () => {
  const dir = await copyFixture();
  try {
    const runner: BuildRunner = { which: async () => false, run: async () => { throw new Error("must not run"); } };
    const report = await runScan(dir, { offline: true, now, env: {}, build: true, buildRunner: runner });
    assert.equal(report.facts["build.status"], "unknown");
    assert.equal(status(report, "build.native-build"), "unchecked");
    assert.ok(report.observations.some((item) => item.id === "build.android" && item.detail.includes("flutter was not found")));
    assert.notEqual(report.verdict, "ready");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a mocked build runs in a temporary copy and its APK and simulator app are read", async () => {
  const dir = await copyFixture();
  const before = (await readdir(dir)).sort();
  const cwds: string[] = [];
  try {
    const runner: BuildRunner = {
      which: async () => true,
      run: async (command, args, cwd) => {
        cwds.push(cwd);
        if (args[1] === "apk") {
          const out = join(cwd, "build/app/outputs/flutter-apk");
          await mkdir(out, { recursive: true });
          await writeFile(join(out, "app-debug.apk"), zipFiles([{ name: "AndroidManifest.xml", data: encodeBinaryXml(35, []) }]));
        } else {
          const app = join(cwd, "build/ios/iphonesimulator/Runner.app");
          await mkdir(app, { recursive: true });
          await writeFile(join(app, "Info.plist"), encodePlist({ CFBundleIdentifier: "dev.example.rc", NSCameraUsageDescription: "Scan cards" }));
        }
        return { code: 0, output: `${command} ok` };
      },
    };
    const report = await runScan(dir, { offline: true, now, env: {}, build: true, buildRunner: runner });
    assert.equal(report.facts["build.status"], "built");
    assert.equal(report.facts["artifact.present"], true);
    assert.equal(status(report, "build.native-build"), "pass");
    assert.ok(cwds.every((cwd) => !cwd.startsWith(dir)));
    assert.deepEqual((await readdir(dir)).sort(), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failing build is a risk with the log tail in the report", async () => {
  const dir = await copyFixture();
  try {
    const runner: BuildRunner = { which: async () => true, run: async () => ({ code: 1, output: "FAILURE: Build failed with an exception." }) };
    const report = await runScan(dir, { offline: true, now, env: {}, build: true, buildRunner: runner });
    assert.equal(report.facts["build.status"], "failed");
    assert.equal(status(report, "build.native-build"), "fail");
    assert.ok(report.observations.some((item) => item.detail.includes("Build failed with an exception")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("without --build the build rule does not apply", async () => {
  const report = await runScan(join(repo, "fixtures/revenuecat/flutter-good"), { offline: true, now, env: {} });
  assert.equal(status(report, "build.native-build"), "not_applicable");
});
