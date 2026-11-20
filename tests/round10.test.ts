import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import AjvImport from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LAUNCHPACK_SCHEMA_VERSION } from "../packages/core/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";
import { addPackByName, loadRegistry, packIntegrity, searchRegistry } from "../packages/packs/src/index.ts";

const repo = new URL("..", import.meta.url).pathname;
const cli = join(repo, "apps/cli/src/index.ts");
const now = new Date("2026-11-20T00:00:00Z");
const Ajv = AjvImport as unknown as new (options?: { strict?: boolean }) => {
  compile(schema: unknown): (data: unknown) => boolean;
};

function run(args: string[], cwd = repo): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd });
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

async function projects(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("pubspec.yaml") || names.has("package.json") || names.has("ProjectSettings") || names.has("settings.gradle.kts") || [...names].some((name) => name.endsWith(".xcodeproj"))) {
      found.push(current);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await walk(join(current, entry.name));
    }
  }
  await walk(dir);
  return found.sort();
}

function surface(report: Awaited<ReturnType<typeof runScan>>) {
  return {
    framework: report.profile.framework,
    verdict: report.verdict,
    schema: report.version,
    findings: report.findings
      .filter((item) => item.status === "fail" || item.status === "unchecked")
      .map((item) => `${item.ruleId}:${item.status}`)
      .sort(),
  };
}

test("native iOS, Android, and Unity use the rule engine and leave unseen facts unchecked", async () => {
  const ios = await runScan(join(repo, "fixtures/native/ios"), { offline: true, now, env: {} });
  assert.equal(ios.profile.framework, "ios");
  assert.equal(ios.facts["ios.deployment_target"], 16);
  assert.equal(ios.facts["capability.ads"], true);
  assert.equal(ios.findings.find((item) => item.ruleId === "sdk.manifest-label-mismatch")?.status, "fail");
  assert.equal(ios.facts["payments.stub_ui"], "absent");
  const android = await runScan(join(repo, "fixtures/native/android"), { offline: true, now, env: {} });
  assert.equal(android.profile.framework, "android");
  assert.equal(android.facts["android.target_sdk"], 28);
  assert.equal(android.facts["android.target_sdk_basis"], "gradle");
  assert.equal(android.findings.find((item) => item.ruleId === "google.target-api")?.status, "fail");
  assert.ok(android.profile.permissions.android.includes("android.permission.CAMERA"));
  assert.equal(android.facts["ios.usage.camera"], "not-applicable");
  const unity = await runScan(join(repo, "fixtures/unity/game"), { offline: true, now, env: {} });
  assert.equal(unity.profile.framework, "unity");
  assert.equal(unity.profile.displayName, "Unity Sample");
  assert.equal(unity.facts["android.target_sdk"], 35);
  assert.equal(unity.facts["android.target_sdk_basis"], "unknown");
  assert.equal(unity.findings.find((item) => item.ruleId === "google.target-api")?.status, "unchecked");
  assert.equal(unity.findings.find((item) => item.ruleId === "sdk.manifest-label-mismatch")?.status, "fail");
});

test("LaunchPack snapshots stay on the schema and the public command list is stable", async () => {
  assert.equal(LAUNCHPACK_SCHEMA_VERSION, 1);
  const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile(join(repo, "schemas/launchpack.schema.json"), "utf8")));
  const registryValidate = new Ajv({ strict: false }).compile(JSON.parse(await readFile(join(repo, "registry/index.schema.json"), "utf8")));
  assert.equal(registryValidate(JSON.parse(await readFile(join(repo, "registry/index.json"), "utf8"))), true);
  const shot: Record<string, ReturnType<typeof surface>> = {};
  for (const project of await projects(join(repo, "fixtures"))) {
    const report = await runScan(project, { offline: true, now, env: {} });
    assert.equal(validate(report), true, relative(repo, project));
    shot[relative(repo, project)] = surface(report);
  }
  const path = join(repo, "tests/snapshots/launchpack.json");
  const body = `${JSON.stringify(shot, null, 2)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === "1") await writeFile(path, body, "utf8");
  assert.equal(await readFile(path, "utf8"), body);
  const help = await run(["help"]);
  for (const command of ["scan", "explain", "init", "labels", "sources check", "history", "dashboard", "pack search", "pack add", "pack integrity", "mcp"]) {
    assert.match(help.stdout, new RegExp(command.replace(" ", "\\s+")));
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--experimental-strip-types", cli, "mcp"], cwd: repo, stderr: "pipe" });
  const client = new Client({ name: "compat", version: "0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "launchymind_apply_fix",
      "launchymind_apply_fixes",
      "launchymind_explain_finding",
      "launchymind_get_overview",
      "launchymind_get_verdict",
      "launchymind_labels",
      "launchymind_propose_fix",
      "launchymind_propose_fixes",
      "launchymind_scan",
    ]);
  } finally {
    await client.close();
  }
});

test("a large synthetic project finishes and says the file cap was reached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-large-"));
  try {
    await mkdir(join(directory, "app/src/main/kotlin/demo"), { recursive: true });
    await writeFile(join(directory, "settings.gradle.kts"), "include(\":app\")\n", "utf8");
    await writeFile(join(directory, "app/build.gradle.kts"), "android { defaultConfig { targetSdk = 36 } }\n", "utf8");
    await writeFile(join(directory, "app/src/main/AndroidManifest.xml"), "<manifest package=\"dev.example.large\"></manifest>\n", "utf8");
    for (let index = 0; index < 220; index += 1) {
      await writeFile(join(directory, "app/src/main/kotlin/demo", `File${index}.kt`), `class File${index}\n`, "utf8");
    }
    const started = Date.now();
    const report = await runScan(directory, { offline: true, now, env: {} });
    assert.ok(Date.now() - started < 8000);
    assert.equal(report.profile.framework, "android");
    assert.ok(report.limitations.some((item) => item.id === "source-scan-capped"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pack search and pack add use the registry hash and refuse a mismatch", async () => {
  const index = await loadRegistry();
  assert.equal(searchRegistry(index, "example").some((item) => item.name === "example-notes"), true);
  assert.equal(await packIntegrity(join(repo, "registry/packs/example-notes")), index.packs[0]?.integrity);
  const directory = await mkdtemp(join(tmpdir(), "launchymind-registry-"));
  try {
    const pack = join(directory, "registry/packs/sample-notes");
    await mkdir(pack, { recursive: true });
    for (const [name, body] of [
      ["pack.yaml", "format: 1\nid: sample.notes\nname: Sample\nversion: \"1.0.0\"\nlicense: Apache-2.0\nengine: \">=1.0.0-rc.1\"\nauthors: [callabens]\nverifiedAt: 2026-11-20\ndescription: Sample data pack.\n"],
      ["rules.yaml", "rules: []\n"],
      ["withheld.yaml", "rules: []\n"],
      ["cases.yaml", "cases: []\n"],
    ] as const) {
      await writeFile(join(pack, name), body, "utf8");
    }
    spawnSync("git", ["init"], { cwd: directory });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: directory });
    spawnSync("git", ["add", "."], { cwd: directory });
    spawnSync("git", ["commit", "-m", "pack"], { cwd: directory });
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    const integrity = await packIntegrity(pack);
    const registry = { schema: 1, packs: [{ name: "sample-notes", description: "Sample data pack for the registry test.", repository: "https://example.test/pack.git", path: "registry/packs/sample-notes", commit, integrity }] };
    const registryPath = join(directory, "registry/index.json");
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    const project = join(directory, "app");
    await mkdir(project, { recursive: true });
    const installed = await addPackByName(project, "sample-notes", registryPath);
    assert.equal(installed.id, "sample.notes");
    registry.packs[0]!.integrity = `sha256:${"ab".repeat(32)}`;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await assert.rejects(addPackByName(project, "sample-notes", registryPath), /do not match the registry integrity hash/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
