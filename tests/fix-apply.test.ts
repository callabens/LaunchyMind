import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyApprovedFix, applyEdits, resolveProjectFile } from "../packages/fixes/src/index.ts";

const repo = new URL("..", import.meta.url).pathname;
const cli = join(repo, "apps/cli/src/index.ts");

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

async function copyFixture(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-fix-"));
  await cp(join(repo, "fixtures/flutter", name), directory, { recursive: true });
  return directory;
}

test("dry-run writes nothing and apply updates the tracking manifest", async () => {
  const dry = await copyFixture("tracking-mismatch");
  const manifest = join(dry, "ios/Runner/PrivacyInfo.xcprivacy");
  const before = await readFile(manifest, "utf8");
  try {
    const preview = await run(["fix", dry, "--rule", "apple.privacy-manifest-tracking", "--dry-run", "--offline"]);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /NSPrivacyTracking/);
    assert.match(preview.stdout, /@@ -/);
    const changed = preview.stdout.split("\n").filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"));
    assert.deepEqual(changed, ["-  <false/>", "+  <true/>"]);
    assert.match(preview.stdout, /Dry run/);
    assert.equal(await readFile(manifest, "utf8"), before);

    const applied = await run(["fix", dry, "--rule", "apple.privacy-manifest-tracking", "--yes", "--offline"]);
    assert.equal(applied.code, 0, applied.stderr);
    const after = await readFile(manifest, "utf8");
    assert.equal(after, before.replace("<false/>", "<true/>"));
    assert.match(applied.stdout, /Before:/);
    assert.match(applied.stdout, /After:/);
  } finally {
    await rm(dry, { recursive: true, force: true });
  }
});

test("a usage-description placeholder is written only with --yes", async () => {
  const directory = await copyFixture("reject-camera");
  const plist = join(directory, "ios/Runner/Info.plist");
  try {
    const refused = await run(["fix", directory, "--rule", "apple.permission-camera", "--offline"]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /--yes/);
    assert.equal((await readFile(plist, "utf8")).includes("NSCameraUsageDescription"), false);

    const applied = await run(["fix", directory, "--rule", "apple.permission-camera", "--yes", "--offline"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(await readFile(plist, "utf8"), /NSCameraUsageDescription/);
    assert.match(applied.stdout, /Before: LIKELY TO BE REJECTED/);
    assert.match(applied.stdout, /After:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AD_ID permission is added when ads do not merge it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-adid-"));
  const manifest = join(directory, "android/app/src/main/AndroidManifest.xml");
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "android/app/src/main"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: ads_id\ndependencies:\n  flutter:\n    sdk: flutter\n  unity_ads_plugin: ^0.1.0\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(manifest, "<manifest package=\"dev.example.ads\">\n  <application/>\n</manifest>\n", "utf8");
    const applied = await run(["fix", directory, "--rule", "google.ad-id-permission", "--yes", "--offline"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(await readFile(manifest, "utf8"), /com\.google\.android\.gms\.permission\.AD_ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path traversal and a dirty git tree are refused", async () => {
  const directory = await copyFixture("tracking-mismatch");
  const manifest = join(directory, "ios/Runner/PrivacyInfo.xcprivacy");
  const before = await readFile(manifest, "utf8");
  try {
    assert.throws(() => resolveProjectFile(directory, "../outside.txt"), /outside the project root/);
    await assert.rejects(applyEdits(directory, [{ path: "ios/../../outside.txt", before: "", after: "nope" }]), /outside the project root/);
    await assert.rejects(readFile(join(directory, "..", "outside.txt"), "utf8"));

    spawnSync("git", ["init"], { cwd: directory });
    const dirty = await run(["fix", directory, "--rule", "apple.privacy-manifest-tracking", "--yes", "--offline"]);
    assert.equal(dirty.code, 1, dirty.stderr);
    assert.match(dirty.stderr, /uncommitted changes/);
    assert.equal(await readFile(manifest, "utf8"), before);

    const allowed = await run(["fix", directory, "--rule", "apple.privacy-manifest-tracking", "--yes", "--allow-dirty", "--offline"]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(await readFile(manifest, "utf8"), /<key>NSPrivacyTracking<\/key>\s*<true\/>/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP apply refuses a mismatched fix id and writes with the exact id", async () => {
  const directory = await copyFixture("tracking-mismatch");
  const manifest = join(directory, "ios/Runner/PrivacyInfo.xcprivacy");
  try {
    const proposal = await (await import("../packages/fixes/src/index.ts")).proposeFix(
      await (await import("../packages/pipeline/src/index.ts")).runScan(directory, { offline: true }),
      "apple.privacy-manifest-tracking",
    );
    assert.equal(proposal.canApply, true);
    assert.equal(proposal.writesFiles, false);
    const wrong = await applyApprovedFix({
      projectPath: directory,
      ruleId: "apple.privacy-manifest-tracking",
      fixId: "not-the-id",
      approved: true,
      dryRun: false,
      allowDirty: true,
      offline: true,
      requireOperator: true,
      operatorEnabled: true,
      requireFixId: true,
    });
    assert.equal(wrong.status, "REFUSED");
    assert.equal(wrong.writesFiles, false);
    assert.match(await readFile(manifest, "utf8"), /<false\/>/);
    const right = await applyApprovedFix({
      projectPath: directory,
      ruleId: "apple.privacy-manifest-tracking",
      fixId: proposal.fixId,
      approved: true,
      dryRun: false,
      allowDirty: true,
      offline: true,
      requireOperator: true,
      operatorEnabled: true,
      requireFixId: true,
    });
    assert.equal(right.status, "APPLIED");
    assert.equal(right.writesFiles, true);
    assert.notEqual(right.before?.verdict, undefined);
    assert.notEqual(right.after?.verdict, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
