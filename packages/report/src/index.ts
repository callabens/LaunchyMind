import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DISCLAIMERS, type Finding, type LaunchReport } from "../../core/src/index.ts";
import { DEFAULT_LOCALE, findI18nDir, isRtl, pickText, translator, type Locale, type Translate } from "../../i18n/src/index.ts";

type RuleTexts = Record<string, { summary?: string; next?: string }>;
const overlays = new Map<Locale, RuleTexts>();

/** Optional per-locale rule explanations in packages/packs/i18n/rules/<locale>.yaml. */
export function ruleOverlay(locale: Locale): RuleTexts {
  const cached = overlays.get(locale);
  if (cached) return cached;
  const path = join(findI18nDir(), "rules", `${locale}.yaml`);
  const loaded = existsSync(path) ? (parse(readFileSync(path, "utf8")) as RuleTexts | null) ?? {} : {};
  overlays.set(locale, loaded);
  return loaded;
}

export function localizedFinding(finding: Finding, locale: Locale): { summary: string; next: string | null; fallback: boolean } {
  const overlay = ruleOverlay(locale)[finding.ruleId] ?? {};
  const summary = pickText({ en: finding.summaryEn, tr: finding.summaryTr, [locale]: locale === "tr" ? finding.summaryTr : overlay.summary }, locale);
  const next = pickText({ en: finding.nextEn, tr: finding.nextTr, [locale]: locale === "tr" ? finding.nextTr : overlay.next }, locale);
  return { summary: summary?.text ?? finding.summaryEn, next: next?.text ?? null, fallback: Boolean(summary?.fallback || next?.fallback) };
}

export function verdictLabel(report: Pick<LaunchReport, "verdict" | "verdictHeadline">, t: Translate): string {
  if (report.verdictHeadline === "NOT READY") return t("verdict.not_ready");
  return t(`verdict.${report.verdict}`);
}

function disclaimer(item: string, t: Translate): string {
  const keys = ["disclaimer.store", "disclaimer.legal", "disclaimer.ready"];
  const index = (DISCLAIMERS as readonly string[]).indexOf(item);
  return index >= 0 && keys[index] ? t(keys[index]) : item;
}

export function renderTerminal(report: LaunchReport, lang: Locale = DEFAULT_LOCALE): string {
  const t = translator(lang);
  const lines: string[] = [
    `${t("report.by", { product: report.product, vendor: report.vendor })}  ${report.toolVersion}`,
    `${t("report.project")}: ${report.profile.displayName ?? report.profile.name ?? report.projectPath}`,
    `${t("report.framework")}: ${report.profile.framework}  iOS: ${yes(report.profile.platforms.ios, t)}  Android: ${yes(report.profile.platforms.android, t)}`,
    `${t("report.pack")}: ${report.pack.id} ${report.pack.version}`,
    `${t("report.mode")}: ${report.offline ? t("report.mode.offline") : t("report.mode.live")}`,
    "",
    `${t("report.verdict")}: ${verdictLabel(report, t)}`,
    ...report.disclaimers.map((item) => `  ${disclaimer(item, t)}`),
    "",
  ];
  const open = report.findings.filter((finding) => finding.status === "fail" || finding.status === "unchecked").sort(byImportance);
  if (open.length === 0) lines.push(t("report.no_open"));
  for (const finding of open) lines.push(...formatFinding(finding, lang, t), "");
  const passed = report.findings.filter((finding) => finding.status === "pass").length;
  const skipped = report.findings.filter((finding) => finding.status === "not_applicable").length;
  lines.push(t("report.totals", { passed, na: skipped, withheld: report.withheld.length }));
  if (report.profile.unknowns.length) {
    lines.push("", t("report.could_not_read"));
    for (const item of report.profile.unknowns) lines.push(`  - ${item}`);
  }
  if (report.sourceWatch.needsReverify.length) {
    lines.push("", t("report.needs_reverify"));
    for (const item of report.sourceWatch.needsReverify) lines.push(`  - ${item.ruleId} ${item.url}`);
  }
  if (report.limitations.length) {
    lines.push("", t("report.limits"));
    for (const item of report.limitations) lines.push(`  - ${item.detail}`);
  }
  return lines.join("\n").trimEnd();
}

export function renderJson(report: LaunchReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderHtml(report: LaunchReport, lang: Locale = DEFAULT_LOCALE): string {
  const t = translator(lang);
  const verdictClass = report.verdict === "ready" ? "ready" : report.verdict === "risky" ? "risky" : "reject";
  const findings = report.findings
    .filter((finding) => finding.status !== "not_applicable")
    .sort(byImportance)
    .map((finding) => findingHtml(finding, lang, t))
    .join("\n");
  const caps = report.profile.capabilities
    .filter((item) => item.present === true)
    .map((item) => `<li>${esc(item.id)}</li>`)
    .join("");
  const limits = report.limitations.map((item) => `<li>${esc(item.detail)}</li>`).join("");
  const withheld = report.withheld.map((item) => `<li><code>${esc(item.ruleId)}</code> — ${esc(item.reason)} <a href="${esc(item.sourceUrl)}">${esc(item.sourceSection)}</a></li>`).join("");
  const unknowns = report.profile.unknowns.map((item) => `<li>${esc(item)}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="${esc(lang)}" dir="${isRtl(lang) ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t("html.title", { product: report.product }))} — ${esc(verdictLabel(report, t))}</title>
<style>
  :root { color-scheme: light; --ink: #1c1915; --paper: #f7f4ee; --line: #d9d2c5; --ready: #1f6b45; --risky: #8a5a12; --reject: #8d2b2b; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 "Iowan Old Style", Palatino, Georgia, serif; color: var(--ink); background: var(--paper); }
  main { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 2rem; line-height: 1.1; margin: 0 0 8px; }
  h2 { font-size: 1.25rem; margin: 32px 0 8px; }
  .meta, .disclaimer { color: #4a453d; }
  .verdict { display: inline-block; margin: 16px 0; padding: 6px 12px; border: 2px solid currentColor; font-weight: 700; letter-spacing: 0.04em; }
  .ready { color: var(--ready); } .risky { color: var(--risky); } .reject { color: var(--reject); }
  article { border-top: 1px solid var(--line); padding: 16px 0; }
  .tag { font: 12px/1 ui-monospace, monospace; letter-spacing: 0.04em; }
  code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { white-space: pre-wrap; background: #fff; border: 1px solid var(--line); padding: 8px 10px; }
  a { color: inherit; }
  ul { padding-left: 1.2rem; }
  [dir="rtl"] ul { padding-left: 0; padding-right: 1.2rem; }
  [dir="rtl"] code, [dir="rtl"] pre, .source { unicode-bidi: isolate; }
  .fallback { color: #6b655b; font-style: italic; }
</style>
</head>
<body>
<main>
  <p class="meta">${esc(t("report.by", { product: report.product, vendor: report.vendor }))} · ${esc(report.toolVersion)} · ${esc(t("report.pack"))} ${esc(report.pack.version)}</p>
  <h1>${esc(report.profile.displayName ?? report.profile.name ?? t("html.untitled"))}</h1>
  <p class="meta">${esc(report.profile.framework)} · iOS ${esc(yes(report.profile.platforms.ios, t))} · Android ${esc(yes(report.profile.platforms.android, t))} · ${esc(report.offline ? t("report.mode.offline") : t("report.mode.live"))}</p>
  <p class="verdict ${verdictClass}">${esc(verdictLabel(report, t))}</p>
  ${report.disclaimers.map((item) => `<p class="disclaimer">${esc(disclaimer(item, t))}</p>`).join("\n  ")}
  <h2>${esc(t("html.why"))}</h2>
  <ul>${report.verdictBecause.map((item) => `<li dir="auto">${esc(item)}</li>`).join("")}</ul>
  <h2>${esc(t("html.capabilities"))}</h2>
  ${caps ? `<ul>${caps}</ul>` : `<p>${esc(t("html.no_capabilities"))}</p>`}
  <h2>${esc(t("html.findings"))}</h2>
  <p class="meta">${esc(t("html.quote_note"))}</p>
  ${findings || `<p>${esc(t("html.no_findings"))}</p>`}
  <h2>${esc(t("report.limits").replace(/:$/, ""))}</h2>
  <ul>${limits}</ul>
  ${unknowns ? `<h2>${esc(t("report.could_not_read").replace(/:$/, ""))}</h2><ul>${unknowns}</ul>` : ""}
  <h2>${esc(t("html.withheld"))}</h2>
  ${withheld ? `<ul>${withheld}</ul>` : `<p>${esc(t("html.none"))}</p>`}
  <p class="meta">${esc(t("html.generated", { date: report.generatedAt }))}</p>
</main>
</body>
</html>
`;
}

function findingHtml(finding: Finding, lang: Locale, t: Translate): string {
  const text = localizedFinding(finding, lang);
  const evidence = finding.evidence.length
    ? `<ul>${finding.evidence.map((item) => `<li dir="auto"><bdi>${esc(item.path ?? item.kind)}${item.line ? `:${item.line}` : ""}</bdi> — ${esc(item.detail)}</li>`).join("")}</ul>`
    : `<p>${esc(t("finding.evidence_none"))}</p>`;
  const textLang = text.fallback ? ` lang="en" dir="ltr"` : "";
  return `<article>
  <p class="tag ${esc(finding.status)}">${esc(t(`status.${finding.status}`))} · ${esc(t(`severity.${finding.severity}`))} · <bdi>${esc(finding.ruleId)}</bdi>${finding.stale ? ` · ${esc(t("finding.stale"))}` : ""}</p>
  <h3>${esc(finding.title)}</h3>
  <p${textLang}>${esc(text.summary)}</p>
  ${text.next ? `<p${textLang}>${esc(t("finding.next"))}: ${esc(text.next)}</p>` : ""}
  ${text.fallback ? `<p class="fallback">${esc(t("finding.english_only"))}</p>` : ""}
  <p>${esc(t("finding.source"))}: <a class="source" lang="en" dir="ltr" href="${esc(finding.sourceUrl)}">${esc(finding.sourcePublisher)} ${esc(finding.sourceSection)}</a>${finding.verifiedAt ? ` · ${esc(t("finding.verified"))} ${esc(finding.verifiedAt)}` : ""}</p>
  <p lang="en" dir="ltr">${esc(finding.checkNote)}</p>
  ${evidence}
</article>`;
}

function formatFinding(finding: Finding, lang: Locale, t: Translate): string[] {
  const text = localizedFinding(finding, lang);
  const lines = [
    `${t(`status.${finding.status}`)}  ${t(`severity.${finding.severity}`)}  ${finding.title}`,
    `  ${text.summary}`,
    ...(text.next ? [`  ${t("finding.next")}: ${text.next}`] : []),
    ...(text.fallback ? [`  (${t("finding.english_only")})`] : []),
    `  ${t("finding.rule")}: ${finding.ruleId}`,
    `  ${t("finding.source")}: ${finding.sourcePublisher} ${finding.sourceSection}`,
    `  ${finding.sourceUrl}`,
    `  ${t("finding.verified")}: ${finding.verifiedAt ?? t("finding.not_verified")}${finding.stale ? ` (${t("finding.stale")})` : ""}`,
    `  ${t("finding.check")}: ${finding.checkNote}`,
  ];
  if (finding.evidence.length === 0) lines.push(`  ${t("finding.evidence")}: ${t("finding.evidence_none")}`);
  for (const item of finding.evidence) {
    const where = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : item.kind;
    lines.push(`  ${t("finding.evidence")}: ${where} — ${item.detail}`);
  }
  return lines;
}

function byImportance(left: Finding, right: Finding): number {
  const statusRank = { fail: 0, unchecked: 1, pass: 2, not_applicable: 3 };
  const severityRank = { blocker: 0, risk: 1, info: 2 };
  return statusRank[left.status] - statusRank[right.status] || severityRank[left.severity] - severityRank[right.severity];
}

function yes(value: boolean, t: Translate): string {
  return value ? t("word.yes") : t("word.no");
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
