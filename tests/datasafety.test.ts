import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../packages/pipeline/src/index.ts";
import { draftLabels, loadSdkBase } from "../packages/labels/src/index.ts";
import { compareDataSafety, DATA_SAFETY_FILE, dataSafetyCsv, playTypeFor, templateFromDraft, writeDataSafetyTemplate } from "../packages/labels/src/datasafety.ts";

const repo = new URL("..", import.meta.url).pathname;
const now = new Date("2026-11-20T00:00:00Z");
const status = (report: Awaited<ReturnType<typeof runScan>>, id: string) => report.findings.find((item) => item.ruleId === id)?.status;

async function copyFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lm-ds-"));
  await cp(join(repo, "fixtures/revenuecat/flutter-good"), dir, { recursive: true });
  return dir;
}

test("without launchymind.datasafety.json the comparison rule does not apply", async () => {
  const dir = await copyFixture();
  try {
    const report = await runScan(dir, { offline: true, now, env: {} });
    assert.equal(report.facts["google.data_safety_declaration"], "missing");
    assert.equal(status(report, "google.data-safety-declaration-sdks"), "not_applicable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the init template stays unchecked until reviewed, then passes; a removed type fails", async () => {
  const dir = await copyFixture();
  try {
    const draft = draftLabels(["purchases_flutter"], await loadSdkBase());
    const written = await writeDataSafetyTemplate(dir, draft);
    assert.equal(written.wrote, true);
    assert.equal((await writeDataSafetyTemplate(dir, draft)).wrote, false);
    let report = await runScan(dir, { offline: true, now, env: {} });
    assert.equal(status(report, "google.data-safety-declaration-sdks"), "unchecked");

    const file = JSON.parse(await readFile(join(dir, DATA_SAFETY_FILE), "utf8"));
    assert.deepEqual(file.types.map((item: { type: string }) => item.type), ["Purchase history"]);
    file.reviewed = true;
    await writeFile(join(dir, DATA_SAFETY_FILE), JSON.stringify(file));
    report = await runScan(dir, { offline: true, now, env: {} });
    assert.equal(status(report, "google.data-safety-declaration-sdks"), "pass");

    file.types = [];
    file.collectsOrShares = false;
    await writeFile(join(dir, DATA_SAFETY_FILE), JSON.stringify(file));
    report = await runScan(dir, { offline: true, now, env: {} });
    assert.equal(status(report, "google.data-safety-declaration-sdks"), "fail");
    const finding = report.findings.find((item) => item.ruleId === "google.data-safety-declaration-sdks");
    assert.ok(finding?.evidence.some((item) => item.detail.includes("Purchase history (revenuecat)")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an invalid declaration is unchecked, never a pass", async () => {
  const dir = await copyFixture();
  try {
    await writeFile(join(dir, DATA_SAFETY_FILE), JSON.stringify({ format: 1, reviewed: true, collectsOrShares: true, types: [{ type: "Not a Play type", collected: true, shared: false }] }));
    const report = await runScan(dir, { offline: true, now, env: {} });
    assert.equal(status(report, "google.data-safety-declaration-sdks"), "unchecked");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ambiguous vendor wording needs a manual mapping and never fails the comparison", async () => {
  assert.equal(playTypeFor("IP address"), null);
  assert.equal(playTypeFor("Device and Account identifiers"), "Device or other IDs");
  const draft = draftLabels(["google_mobile_ads"], await loadSdkBase());
  const result = compareDataSafety({ format: 1, reviewed: true, collectsOrShares: false, types: [] }, true, [], draft);
  for (const item of result.unmapped) assert.equal(result.missingTypes.some((missing) => missing.type === item.type), false);
  const csv = dataSafetyCsv(draft);
  assert.match(csv.split("\n")[0] ?? "", /^draft,play_data_type,vendor_wording/);
  assert.equal(templateFromDraft(draft).reviewed, false);
});
