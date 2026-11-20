import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import AjvImport from "ajv";

const repo = new URL("..", import.meta.url).pathname;
const cli = join(repo, "apps/cli/src/index.ts");
const fixture = (name: string) => join(repo, "fixtures/flutter", name);

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

test("pack validate accepts the core pack", async () => {
  const result = await run(["pack", "validate"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /launchymind.core/);
});

test("cli scans the reject and risky fixtures", async () => {
  const rejected = await run(["scan", fixture("reject-camera"), "--offline"]);
  assert.equal(rejected.code, 3, rejected.stderr);
  assert.match(rejected.stdout, /LIKELY TO BE REJECTED/);
  assert.match(rejected.stdout, /apple\.permission-camera/);

  const risky = await run(["scan", fixture("risky-accounts"), "--offline", "--json"]);
  assert.equal(risky.code, 0, risky.stderr);
  const strict = await run(["scan", fixture("risky-accounts"), "--offline", "--fail-on", "risky"]);
  assert.equal(strict.code, 2, strict.stderr);
  const report = JSON.parse(risky.stdout) as { verdict: string; disclaimers: string[] };
  assert.equal(report.verdict, "risky");
  const Ajv = AjvImport as unknown as new (options?: { strict?: boolean }) => {
    compile(schema: unknown): (data: unknown) => boolean;
  };
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(JSON.parse(await readFile(join(repo, "schemas/launchpack.schema.json"), "utf8")));
  assert.equal(validate(JSON.parse(risky.stdout)), true);
});

test("cli writes an html report and reaches ready against a local server", async () => {
  const privacy = await readFile(join(fixture("ready-notes"), "live/privacy.html"), "utf8");
  const support = await readFile(join(fixture("ready-notes"), "live/support.html"), "utf8");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/support" ? support : privacy);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const directory = await mkdtemp(join(tmpdir(), "launchymind-cli-"));
  const htmlPath = join(directory, "report.html");
  try {
    await cp(fixture("ready-notes"), join(directory, "app"), { recursive: true });
    const app = join(directory, "app");
    for (const relative of ["lib/main.dart", "ios/Runner/Info.plist", ".launchymind/project.yaml"]) {
      const path = join(app, relative);
      await writeFile(path, (await readFile(path, "utf8")).replaceAll("8765", String(port)), "utf8");
    }
    const result = await run(["scan", app, "--html", htmlPath]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /READY/);
    assert.equal(html.includes("<script"), false);
    assert.match(html, /not legal advice/);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fix apply does not write files", async () => {
  const sentinel = join(fixture("reject-camera"), "SHOULD_NOT_EXIST.txt");
  const result = await run(["fix", "apply", "apple.permission-camera", "--approved"], fixture("reject-camera"));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /launchymind fix <path> --rule/);
  await assert.rejects(readFile(sentinel, "utf8"));
});

test("mcp server lists the planned tools and cannot set a verdict", async () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  delete env.LAUNCHYMIND_ALLOW_APPLY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", cli, "mcp"],
    cwd: fixture("reject-camera"),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "launchymind-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "launchymind_apply_fix",
      "launchymind_apply_fixes",
      "launchymind_explain_finding",
      "launchymind_get_overview",
      "launchymind_get_verdict",
      "launchymind_propose_fix",
      "launchymind_propose_fixes",
      "launchymind_scan",
    ]);
    assert.equal(names.some((name) => name.includes("set_verdict")), false);
    const verdictTool = listed.tools.find((tool) => tool.name === "launchymind_get_verdict");
    assert.equal(JSON.stringify(verdictTool?.inputSchema).includes("\"verdict\""), false);
    const verdict = await client.callTool({ name: "launchymind_get_verdict", arguments: { offline: true } });
    const body = JSON.parse((verdict.content as Array<{ text: string }>)[0]?.text ?? "{}") as { verdict: string };
    assert.equal(body.verdict, "reject");
    const applied = await client.callTool({
      name: "launchymind_apply_fix",
      arguments: { ruleId: "apple.permission-camera", approved: true },
    });
    const applyBody = JSON.parse((applied.content as Array<{ text: string }>)[0]?.text ?? "{}") as { status: string; writesFiles: boolean };
    assert.equal(applyBody.status, "BLOCKED");
    assert.equal(applyBody.writesFiles, false);
    const proposed = await client.callTool({
      name: "launchymind_propose_fix",
      arguments: { ruleId: "apple.permission-camera", offline: true },
    });
    const proposal = JSON.parse((proposed.content as Array<{ text: string }>)[0]?.text ?? "{}") as { writesFiles: boolean; available: boolean };
    assert.equal(proposal.writesFiles, false);
    assert.equal(proposal.available, true);
  } finally {
    await client.close();
  }
});
