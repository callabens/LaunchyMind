import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyApprovedFixes } from "../packages/fixes/src/index.ts";
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

async function writePack(directory: string, extra = ""): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "pack.yaml"), `format: 1
id: example.notes
name: Example notes
version: 0.0.1
license: Apache-2.0
engine: ">=0.1.0-dev.1"
authors: [callabens]
verifiedAt: 2026-11-20
description: Example data-only pack.
`, "utf8");
  await writeFile(join(directory, "rules.yaml"), `rules:
  - id: example.note-present
    title: Example pack records a passing note
    severity: info
    platforms: [any]
    enabled: true
    origin: product
    verification:
      status: verified
      verifiedAt: 2026-11-20
      method: product-rule
    source:
      url: https://github.com/callabens/LaunchyMind
      section: example
      publisher: LaunchyMind
    summary:
      en: "This example rule passes for a Flutter project and does not describe a store duty."
      tr: "Bu örnek kural bir Flutter projesi için geçer ve mağaza yükümlülüğü anlatmaz."
    appliesWhen:
      all:
        - { fact: framework.flutter, neq: "unused" }
    evaluate:
      pass:
        all:
          - { fact: framework.flutter, eq: true }
      fail:
        all:
          - { fact: framework.flutter, eq: false }
          - { fact: framework.react_native, eq: false }
          - { fact: framework.expo, eq: false }
    check:
      confidence: direct
      note: "Example data. It does not read a store page."
`, "utf8");
  await writeFile(join(directory, "withheld.yaml"), "rules: []\n", "utf8");
  await writeFile(join(directory, "cases.yaml"), `cases:
  - id: note-pass
    rule: example.note-present
    expect: pass
    facts: { framework.flutter: true }
`, "utf8");
  if (extra) await writeFile(join(directory, extra), "console.log(1)\n", "utf8");
}

test("fix --all shows every writable diff and writes only with --yes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-all-"));
  const manifest = join(directory, "ios/Runner/PrivacyInfo.xcprivacy");
  const plist = join(directory, "ios/Runner/Info.plist");
  const android = join(directory, "android/app/src/main/AndroidManifest.xml");
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await mkdir(join(directory, "android/app/src/main"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: many\ndependencies:\n  flutter:\n    sdk: flutter\n  camera: ^0.10.0\n  unity_ads_plugin: ^0.3.0\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(plist, "<plist><dict>\n  <key>CFBundleDisplayName</key>\n  <string>Many</string>\n</dict></plist>\n", "utf8");
    await writeFile(manifest, "<plist><dict>\n  <key>NSPrivacyTracking</key>\n  <false/>\n  <key>NSPrivacyCollectedDataTypes</key>\n  <array><dict><key>NSPrivacyCollectedDataTypeTracking</key><true/></dict></array>\n</dict></plist>\n", "utf8");
    await writeFile(android, "<manifest>\n  <application/>\n</manifest>\n", "utf8");
    const beforeManifest = await readFile(manifest, "utf8");
    const beforePlist = await readFile(plist, "utf8");
    const dry = await run(["fix", directory, "--all", "--dry-run", "--offline"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /apple.privacy-manifest-tracking/);
    assert.match(dry.stdout, /apple.permission-camera/);
    assert.match(dry.stdout, /google.ad-id-permission/);
    assert.match(dry.stdout, /Dry run/);
    assert.equal(await readFile(manifest, "utf8"), beforeManifest);
    assert.equal(await readFile(plist, "utf8"), beforePlist);

    const blocked = await run(["fix", directory, "--all", "--offline"]);
    assert.equal(blocked.code, 1, blocked.stdout);
    assert.match(blocked.stderr, /--yes/);
    assert.equal(await readFile(plist, "utf8"), beforePlist);

    const applied = await run(["fix", directory, "--all", "--yes", "--offline"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(await readFile(manifest, "utf8"), beforeManifest.replace("<false/>", "<true/>"));
    assert.match(await readFile(plist, "utf8"), /NSCameraUsageDescription/);
    assert.match(await readFile(plist, "utf8"), /CFBundleDisplayName/);
    assert.match(await readFile(android, "utf8"), /AD_ID/);
    assert.match(applied.stdout, /Before:/);
    assert.match(applied.stdout, /After:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply fixes approves one id and skips the rest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-one-"));
  const plist = join(directory, "ios/Runner/Info.plist");
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: one\ndependencies:\n  flutter:\n    sdk: flutter\n  camera: ^0.10.0\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(plist, "<plist><dict></dict></plist>\n", "utf8");
    const report = await runScan(directory, { offline: true, now });
    const proposals = await (await import("../packages/fixes/src/index.ts")).listWritableFixes(report);
    const camera = proposals.find((item) => item.ruleId === "apple.permission-camera");
    assert.ok(camera?.fixId);
    const wrong = await applyApprovedFixes({
      projectPath: directory,
      approvals: [{ ruleId: "apple.permission-camera", fixId: "nope", approved: true }],
      dryRun: false,
      allowDirty: true,
      offline: true,
      requireFixId: true,
    });
    assert.equal(wrong.writesFiles, false);
    assert.equal(wrong.status, "REFUSED");
    assert.equal((await readFile(plist, "utf8")).includes("NSCameraUsageDescription"), false);
    const result = await applyApprovedFixes({
      projectPath: directory,
      approvals: [{ ruleId: "apple.permission-camera", fixId: camera.fixId, approved: true }],
      dryRun: false,
      allowDirty: true,
      offline: true,
      requireFixId: true,
    });
    assert.equal(result.writesFiles, true);
    assert.match(await readFile(plist, "utf8"), /NSCameraUsageDescription/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("init writes only the answers that were passed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-init-"));
  const project = join(directory, ".launchymind", "project.yaml");
  try {
    await mkdir(join(directory, "lib"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: initapp\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    const blank = await run(["init", directory, "--yes"]);
    assert.equal(blank.code, 0, blank.stderr);
    assert.match(blank.stdout, /unchecked/);
    await assert.rejects(readFile(project, "utf8"));

    const asked = await run(["init", directory]);
    assert.equal(asked.code, 1, asked.stdout);
    assert.match(asked.stderr, /--set/);
    await assert.rejects(readFile(project, "utf8"));

    const set = await run(["init", directory, "--set", "attestations.apple.xcode-sdk=true", "--set", "google.account=organization"]);
    assert.equal(set.code, 0, set.stderr);
    const text = await readFile(project, "utf8");
    assert.match(text, /apple.xcode-sdk: true/);
    assert.match(text, /account: organization/);
    assert.equal(text.includes("data-safety-ad-id"), false);
    assert.equal(text.includes("age-rating"), false);

    const report = await runScan(directory, { offline: true, now });
    assert.equal(report.facts["attestation.apple.xcode_sdk"], "yes");
    assert.equal(report.facts["attestation.apple.age_rating"], "unknown");
    assert.equal(report.facts["google.account"], "organization");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path_provider is covered only inside the foundation manifest range", async () => {
  async function project(foundation: string | null): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "launchymind-provider-"));
    await mkdir(join(directory, "lib"), { recursive: true });
    await mkdir(join(directory, "ios/Runner"), { recursive: true });
    await writeFile(join(directory, "pubspec.yaml"), "name: paths\ndependencies:\n  flutter:\n    sdk: flutter\n  path_provider: ^2.1.4\n", "utf8");
    const foundationLock = foundation ? `  path_provider_foundation:\n    version: "${foundation}"\n` : "";
    await writeFile(join(directory, "pubspec.lock"), `packages:\n  path_provider:\n    version: "2.1.4"\n${foundationLock}sdks:\n  flutter: ">=3.16.0"\n`, "utf8");
    await writeFile(join(directory, "lib/main.dart"), "void main() {}\n", "utf8");
    await writeFile(join(directory, "ios/Runner/Info.plist"), "<plist><dict></dict></plist>\n", "utf8");
    return directory;
  }
  const old = await project("2.4.0");
  const current = await project("2.6.0");
  const missing = await project(null);
  try {
    const covered = await runScan(old, { offline: true, now });
    assert.equal(covered.findings.find((item) => item.ruleId === "apple.listed-sdk-manifest")?.status, "pass");
    const removed = await runScan(current, { offline: true, now });
    const finding = removed.findings.find((item) => item.ruleId === "apple.listed-sdk-manifest");
    assert.equal(finding?.status, "unchecked");
    assert.match(`${finding?.checkNote ?? ""}\n${finding?.evidence.map((item) => item.detail).join("\n")}`, /2\.6\.0/);
    const absent = await runScan(missing, { offline: true, now });
    assert.equal(absent.findings.find((item) => item.ruleId === "apple.listed-sdk-manifest")?.status, "unchecked");
  } finally {
    await rm(old, { recursive: true, force: true });
    await rm(current, { recursive: true, force: true });
    await rm(missing, { recursive: true, force: true });
  }
});

test("pack add accepts data, refuses code, and the scan loads the pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchymind-pack-"));
  const source = join(root, "source");
  const evil = join(root, "evil");
  const project = join(root, "app");
  try {
    await writePack(source);
    spawnSync("git", ["init"], { cwd: source });
    await mkdir(join(project, "lib"), { recursive: true });
    await writeFile(join(project, "pubspec.yaml"), "name: packed\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
    await writeFile(join(project, "lib/main.dart"), "void main() {}\n", "utf8");
    const added = await run(["pack", "add", source, "--project", project]);
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /example.notes/);
    const listed = await run(["pack", "list", "--project", project]);
    assert.match(listed.stdout, /example.notes/);
    const report = await runScan(project, { offline: true, now });
    assert.equal(report.findings.find((item) => item.ruleId === "example.note-present")?.status, "pass");

    await writePack(evil, "run.js");
    const refused = await run(["pack", "add", evil, "--project", project]);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stderr, /data only/);
    const removed = await run(["pack", "remove", "example.notes", "--project", project]);
    assert.equal(removed.code, 0, removed.stderr);
    const after = await run(["pack", "list", "--project", project]);
    assert.match(after.stdout, /No project packs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("react native and expo projects use the platform rules they can see", async () => {
  const react = await runScan(join(repo, "fixtures/react-native/camera-gap"), { offline: true, now });
  assert.equal(react.profile.framework, "react-native");
  assert.equal(react.facts["framework.react_native"], true);
  assert.equal(react.facts["framework.expo"], false);
  assert.equal(react.findings.find((item) => item.ruleId === "product.flutter-project")?.status, "pass");
  assert.equal(react.findings.find((item) => item.ruleId === "apple.permission-camera")?.status, "fail");
  assert.equal(react.facts["capability.camera"], true);

  const expo = await runScan(join(repo, "fixtures/expo/plain"), { offline: true, now });
  assert.equal(expo.profile.framework, "expo");
  assert.equal(expo.facts["framework.expo"], true);
  assert.equal(expo.profile.displayName, "Plain Notes");
  assert.equal(expo.findings.find((item) => item.ruleId === "product.flutter-project")?.status, "pass");
  assert.equal(expo.findings.find((item) => item.ruleId === "apple.xcode-sdk")?.status, "unchecked");
  assert.equal(expo.findings.find((item) => item.ruleId === "apple.permission-camera")?.status, "not_applicable");
  assert.notEqual(expo.verdict, "reject");
});
