import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { KNOWN_FACTS } from "../packages/core/src/index.ts";
import { scriptedChecker } from "../packages/live/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";
import { renderHtml } from "../packages/report/src/index.ts";

const root = new URL("..", import.meta.url);
const fixture = (name: string) => new URL(`fixtures/flutter/${name}`, root).pathname;
const now = new Date("2026-11-19T00:00:00Z");

test("reject fixture fails the camera purpose rule", async () => {
  const report = await runScan(fixture("reject-camera"), { offline: true, now });
  assert.equal(report.verdict, "reject");
  const camera = report.findings.find((finding) => finding.ruleId === "apple.permission-camera");
  assert.equal(camera?.status, "fail");
  assert.equal(camera?.severity, "blocker");
  assert.equal(camera?.evidence.some((item) => item.path === "pubspec.yaml"), true);
  assert.equal(report.withheld.some((rule) => rule.ruleId === "kvkk.principle-2026-347"), true);
  assert.equal(report.findings.some((finding) => finding.ruleId === "kvkk.principle-2026-347"), false);
  assert.equal(report.disclaimers.some((line) => line.includes("not store approval")), true);
  assert.equal(report.disclaimers.some((line) => line.includes("not legal advice")), true);
});

test("risky fixture has no blocker failure and is not ready", async () => {
  const report = await runScan(fixture("risky-accounts"), { offline: true, now });
  assert.equal(report.verdict, "risky");
  assert.equal(report.findings.some((finding) => finding.status === "fail" && finding.severity === "blocker"), false);
  assert.equal(report.findings.some((finding) => finding.status === "unchecked"), true);
  assert.equal(report.profile.capabilities.find((item) => item.id === "accounts")?.present, true);
  const deletion = report.findings.find((finding) => finding.ruleId === "apple.account-deletion");
  assert.equal(deletion?.status, "pass");
});

test("ready fixture is ready only when the live pages answer the rules", async () => {
  const offline = await runScan(fixture("ready-notes"), { offline: true, now });
  assert.equal(offline.verdict, "risky");
  assert.equal(offline.findings.some((finding) => finding.ruleId === "apple.privacy-policy-content" && finding.status === "unchecked"), true);

  const privacy = await readFile(new URL("../fixtures/flutter/ready-notes/live/privacy.html", import.meta.url), "utf8");
  const support = await readFile(new URL("../fixtures/flutter/ready-notes/live/support.html", import.meta.url), "utf8");
  const checker = scriptedChecker({
    "http://127.0.0.1:8765/privacy": { status: 200, body: privacy },
    "http://127.0.0.1:8765/support": { status: 200, body: support },
  });
  const report = await runScan(fixture("ready-notes"), { now, liveChecker: checker });
  const open = report.findings.filter((finding) => finding.status === "fail" || finding.status === "unchecked");
  assert.deepEqual(open.map((finding) => `${finding.ruleId}:${finding.status}`), []);
  assert.equal(report.verdict, "ready");
  for (const fact of KNOWN_FACTS) assert.equal(Object.prototype.hasOwnProperty.call(report.facts, fact), true, fact);
  const html = renderHtml(report);
  assert.equal(html.includes("<script"), false);
  assert.match(html, /READY/);
  assert.match(html, /not store approval/);
  assert.match(html, /apple.permission-camera/);
});

test("html escapes project text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launchymind-escape-"));
  try {
    await writeFile(join(directory, "pubspec.yaml"), "name: <script>alert(1)</script>\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf8");
    const report = await runScan(directory, { offline: true, now });
    const html = renderHtml(report);
    assert.equal(html.includes("<script>alert"), false);
    assert.match(html, /&lt;script&gt;alert/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline mode does not call the network checker", async () => {
  let calls = 0;
  const checker = {
    async check(url: string) {
      calls += 1;
      return { url, status: "ok" as const, httpStatus: 200, placeholder: false, text: "", error: null };
    },
  };
  await runScan(fixture("ready-notes"), { offline: true, now, liveChecker: checker });
  assert.equal(calls, 0);
});

test("a local server can satisfy the ready fixture", async () => {
  const privacy = await readFile(new URL("../fixtures/flutter/ready-notes/live/privacy.html", import.meta.url), "utf8");
  const support = await readFile(new URL("../fixtures/flutter/ready-notes/live/support.html", import.meta.url), "utf8");
  const server = createServer((request, response) => {
    const body = request.url === "/support" ? support : privacy;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address ? address.port : 0;
  const directory = await mkdtemp(join(tmpdir(), "launchymind-ready-"));
  try {
    const { cp } = await import("node:fs/promises");
    await cp(fixture("ready-notes"), directory, { recursive: true });
    for (const relative of ["lib/main.dart", "ios/Runner/Info.plist", ".launchymind/project.yaml"]) {
      const path = join(directory, relative);
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replaceAll("8765", String(port)), "utf8");
    }
    const report = await runScan(directory, { now });
    assert.equal(report.verdict, "ready");
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
