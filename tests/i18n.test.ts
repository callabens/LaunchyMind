import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectLocale, findI18nDir, isRtl, LOCALES, loadCatalog, matchLocale, translator } from "../packages/i18n/src/index.ts";
import { runScan } from "../packages/pipeline/src/index.ts";
import { renderHtml, renderTerminal } from "../packages/report/src/index.ts";
import { renderDashboard } from "../packages/history/src/index.ts";
import { findCorePackDir } from "../packages/core/src/index.ts";
import { loadPack } from "../packages/rules/src/index.ts";
import { parse } from "yaml";

const run = promisify(execFile);
const repo = new URL("..", import.meta.url).pathname;
const cli = join(repo, "apps/cli/src/index.ts");
const now = new Date("2026-11-20T00:00:00Z");

test("every locale catalog has exactly the English keys and the same placeholders", async () => {
  const files = (await readdir(join(findI18nDir(), "ui"))).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")).sort();
  assert.deepEqual(files, [...LOCALES].sort());
  const english = loadCatalog("en");
  const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
  for (const locale of LOCALES) {
    const catalog = loadCatalog(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), `${locale} keys`);
    for (const [key, value] of Object.entries(english)) {
      assert.ok(catalog[key]?.trim(), `${locale} ${key} is empty`);
      assert.deepEqual(placeholders(catalog[key] ?? ""), placeholders(value), `${locale} ${key} placeholders`);
    }
  }
});

test("store terms stay as the stores write them", () => {
  for (const locale of LOCALES) {
    const t = translator(locale);
    assert.match(t("labels.play"), /Data safety/, locale);
    assert.match(t("labels.apple"), /App Store/, locale);
  }
});

test("locale detection: --lang, then the first set POSIX variable, then VS Code, then en", () => {
  assert.equal(detectLocale({}, "ja"), "ja");
  assert.throws(() => detectLocale({}, "xx"), /Unsupported language xx/);
  assert.equal(detectLocale({ LANG: "de_DE.UTF-8" }), "de");
  assert.equal(detectLocale({ LC_ALL: "pt_BR.UTF-8", LANG: "de_DE.UTF-8" }), "pt-BR");
  assert.equal(detectLocale({ LC_ALL: "C", LANG: "de_DE.UTF-8" }), "en");
  assert.equal(detectLocale({ VSCODE_NLS_CONFIG: JSON.stringify({ locale: "zh-cn" }) }), "zh-Hans");
  assert.equal(detectLocale({ VSCODE_NLS_CONFIG: "{" }), "en");
  assert.equal(matchLocale("zh-TW"), null);
  assert.equal(matchLocale("pt-PT"), "pt-BR");
  assert.equal(matchLocale("ko-KR"), "ko");
  assert.equal(detectLocale({}), "en");
});

test("Arabic HTML report and dashboard are right-to-left; others are left-to-right", async () => {
  const report = await runScan(join(repo, "fixtures/revenuecat/flutter-bad"), { offline: true, now, env: {} });
  const ar = renderHtml(report, "ar");
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.ok(ar.includes(translator("ar")("html.findings")));
  assert.match(renderHtml(report, "de"), /<html lang="de" dir="ltr">/);
  assert.match(renderDashboard([], [], "ar"), /<html lang="ar" dir="rtl">/);
  assert.equal(isRtl("ar"), true);
  assert.equal(isRtl("ja"), false);
});

test("translated reports keep the verdict, rule ids, and source URLs; untranslated explanations fall back to English with a note", async () => {
  const report = await runScan(join(repo, "fixtures/revenuecat/flutter-bad"), { offline: true, now, env: {} });
  const en = renderTerminal(report, "en");
  for (const locale of LOCALES) {
    const text = renderTerminal(report, locale);
    const t = translator(locale);
    assert.ok(text.includes(`${t("report.verdict")}: ${t(`verdict.${report.verdict}`)}`) || text.includes(t("verdict.not_ready")), locale);
    for (const finding of report.findings.filter((item) => item.status === "fail")) {
      assert.ok(text.includes(finding.ruleId), `${locale} ${finding.ruleId}`);
      assert.ok(text.includes(finding.sourceUrl), `${locale} ${finding.sourceUrl}`);
    }
    if (locale !== "en" && locale !== "tr") assert.ok(text.includes(t("finding.english_only")), locale);
  }
  assert.equal(en.includes(translator("en")("finding.english_only")), false);
  const tr = renderTerminal(report, "tr");
  const failing = report.findings.find((item) => item.status === "fail");
  assert.ok(failing && tr.includes(failing.summaryTr));
});

test("cli --lang picks the catalog and rejects an unknown language", async () => {
  const fixture = join(repo, "fixtures/revenuecat/flutter-bad");
  const ja = await run(process.execPath, ["--experimental-strip-types", cli, "scan", fixture, "--offline", "--lang", "ja", "--fail-on", "none"]);
  assert.match(ja.stdout, /判定: /);
  const viaEnv = await run(process.execPath, ["--experimental-strip-types", cli, "scan", fixture, "--offline", "--fail-on", "none"], { env: { ...process.env, LC_ALL: "", LANG: "fr_FR.UTF-8" } });
  assert.match(viaEnv.stdout, /Verdict : |Verdict: /);
  assert.match(viaEnv.stdout, /Projet: /);
  await assert.rejects(run(process.execPath, ["--experimental-strip-types", cli, "scan", fixture, "--offline", "--lang", "xx"]), /Unsupported language xx/);
});

test("rule source quotes are not part of the catalogs", async () => {
  const raw = await readFile(join(findI18nDir(), "ui", "en.json"), "utf8");
  assert.equal(/https?:\/\//.test(raw), false);
});

test("rule explanation overlays only name rules that exist", async () => {
  const dir = join(findI18nDir(), "rules");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".yaml"));
  const ids = new Set<string>();
  const pack = await loadPack(findCorePackDir());
  for (const rule of pack.rules) ids.add(rule.id);
  for (const legal of await readdir(join(findCorePackDir(), "..", "legal"))) {
    for (const rule of (await loadPack(join(findCorePackDir(), "..", "legal", legal))).rules) ids.add(rule.id);
  }
  for (const file of files) {
    assert.ok((LOCALES as readonly string[]).includes(file.replace(/\.yaml$/, "")), file);
    const overlay = parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown> | null;
    for (const id of Object.keys(overlay ?? {})) assert.ok(ids.has(id), `${file}: ${id}`);
  }
});

test("a rule overlay replaces the English explanation for that locale only", async () => {
  const { localizedFinding } = await import("../packages/report/src/index.ts");
  const finding = { ruleId: "apple.privacy-policy-in-app", summaryEn: "English summary text.", summaryTr: "Türkçe özet.", nextEn: "English next.", nextTr: "Türkçe adım." } as Parameters<typeof localizedFinding>[0];
  const de = localizedFinding(finding, "de");
  assert.equal(de.fallback, false);
  assert.match(de.summary, /Richtlinie 5\.1\.1\(i\)/);
  const ko = localizedFinding(finding, "ko");
  assert.equal(ko.fallback, true);
  assert.equal(ko.summary, "English summary text.");
  assert.equal(localizedFinding(finding, "tr").summary, "Türkçe özet.");
});
