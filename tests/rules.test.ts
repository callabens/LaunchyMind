import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import AjvImport from "ajv";
import { findCorePackDir, isStale, ruleSchema } from "../packages/core/src/index.ts";
import { loadPack, runCases } from "../packages/rules/src/index.ts";
import { decideVerdict } from "../packages/verdict/src/index.ts";
import type { Finding } from "../packages/core/src/index.ts";

const packDir = findCorePackDir();

test("core pack loads, matches the JSON schema, and its cases pass", async () => {
  const pack = await loadPack(packDir);
  assert.equal(pack.meta.id, "launchymind.core");
  assert.equal(pack.withheld.some((rule) => rule.id === "kvkk.principle-2026-347"), true);
  assert.equal(pack.withheld.every((rule) => rule.enabled === false), true);
  assert.equal(pack.rules.every((rule) => rule.verification.status === "verified"), true);
  const results = runCases(pack);
  const failed = results.filter((item) => item.actual !== item.expected);
  assert.deepEqual(failed, []);

  const Ajv = AjvImport as unknown as new (options?: { allErrors?: boolean; strict?: boolean }) => {
    compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown };
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(await readFile(new URL("../schemas/rule.schema.json", import.meta.url), "utf8")));
  const document = parse(await readFile(`${packDir}/rules.yaml`, "utf8")) as { rules: unknown[] };
  for (const rule of document.rules) {
    assert.equal(validate(rule), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ id: "missing.fields" }), false);
});

test("a rule without a source is rejected", () => {
  const parsed = ruleSchema.safeParse({
    id: "apple.example",
    title: "Example rule without a source",
    severity: "blocker",
    platforms: ["ios"],
    enabled: true,
    origin: "store",
    verification: { status: "verified", verifiedAt: "2026-11-19" },
    summary: { en: "This summary is long enough to pass the length check.", tr: "Bu özet yeterince uzun." },
    appliesWhen: { all: [{ fact: "platform.ios", eq: true }] },
    evaluate: { fail: { all: [{ fact: "platform.ios", eq: true }] } },
    check: { confidence: "direct", note: "This note is long enough." },
  });
  assert.equal(parsed.success, false);
});

test("an enabled unverified rule is rejected", () => {
  const parsed = ruleSchema.safeParse({
    id: "kvkk.example",
    title: "Unverified rule must stay off",
    severity: "risk",
    platforms: ["any"],
    enabled: true,
    origin: "legal",
    verification: { status: "needs-manual-verification", note: "Not checked." },
    source: { url: "https://www.kvkk.gov.tr/", section: "unknown", publisher: "KVKK" },
    summary: { en: "This summary is long enough to pass the length check.", tr: "Bu özet yeterince uzun." },
    appliesWhen: { all: [{ fact: "platform.ios", eq: true }] },
    evaluate: { fail: { all: [{ fact: "platform.ios", eq: true }] } },
    check: { confidence: "heuristic", note: "This note is long enough." },
  });
  assert.equal(parsed.success, false);
});

test("verdict comes only from findings", () => {
  const finding = (status: Finding["status"], severity: Finding["severity"], ruleId: string): Finding => ({
    ruleId,
    title: ruleId,
    status,
    severity,
    origin: "store",
    confidence: "direct",
    summaryEn: "summary",
    summaryTr: "özet",
    sourceUrl: "https://example.com",
    sourceSection: "1",
    sourcePublisher: "Example",
    verifiedAt: "2020-01-01",
    stale: true,
    checkNote: "note",
    nextEn: null,
    nextTr: null,
    evidence: [],
    fix: null,
  });
  assert.equal(decideVerdict([finding("fail", "blocker", "a")]).verdict, "reject");
  assert.equal(decideVerdict([finding("fail", "blocker", "a"), finding("unchecked", "blocker", "b")]).verdict, "reject");
  assert.equal(decideVerdict([finding("fail", "risk", "a")]).verdict, "risky");
  assert.equal(decideVerdict([finding("unchecked", "blocker", "a")]).verdict, "risky");
  assert.equal(decideVerdict([finding("pass", "blocker", "a",)]).verdict, "ready");
  assert.equal(decideVerdict([]).verdict, "risky");
  assert.equal(isStale("2020-01-01", new Date("2026-11-19T00:00:00Z"), 180), true);
  assert.equal(isStale("2026-11-19", new Date("2026-11-19T00:00:00Z"), 180), false);
});
