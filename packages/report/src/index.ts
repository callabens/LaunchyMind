import type { Finding, LaunchReport } from "../../core/src/index.ts";

export function renderTerminal(report: LaunchReport, lang: "en" | "tr" = "en"): string {
  const lines: string[] = [
    `${report.product} by ${report.vendor}  ${report.toolVersion}`,
    `Project: ${report.profile.displayName ?? report.profile.name ?? report.projectPath}`,
    `Framework: ${report.profile.framework}  iOS: ${yes(report.profile.platforms.ios)}  Android: ${yes(report.profile.platforms.android)}`,
    `Pack: ${report.pack.id} ${report.pack.version}`,
    `Mode: ${report.offline ? "offline" : "live checks enabled"}`,
    "",
    `Verdict: ${report.verdictHeadline}`,
    ...report.disclaimers.map((item) => `  ${item}`),
    "",
  ];
  const open = report.findings.filter((finding) => finding.status === "fail" || finding.status === "unchecked").sort(byImportance);
  if (open.length === 0) lines.push("No failed or unchecked rules.");
  for (const finding of open) lines.push(...formatFinding(finding, lang), "");
  const passed = report.findings.filter((finding) => finding.status === "pass").length;
  const skipped = report.findings.filter((finding) => finding.status === "not_applicable").length;
  lines.push(`Passed: ${passed}  Not applicable: ${skipped}  Withheld rules: ${report.withheld.length}`);
  if (report.profile.unknowns.length) {
    lines.push("", "Could not read:");
    for (const item of report.profile.unknowns) lines.push(`  - ${item}`);
  }
  if (report.sourceWatch.needsReverify.length) {
    lines.push("", "Needs re-verify (the source page changed; the rule was not edited):");
    for (const item of report.sourceWatch.needsReverify) lines.push(`  - ${item.ruleId} ${item.url}`);
  }
  if (report.limitations.length) {
    lines.push("", "Limits of this scan:");
    for (const item of report.limitations) lines.push(`  - ${item.detail}`);
  }
  return lines.join("\n").trimEnd();
}

export function renderJson(report: LaunchReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderHtml(report: LaunchReport): string {
  const verdictClass = report.verdict === "ready" ? "ready" : report.verdict === "risky" ? "risky" : "reject";
  const findings = report.findings
    .filter((finding) => finding.status !== "not_applicable")
    .sort(byImportance)
    .map((finding) => findingHtml(finding))
    .join("\n");
  const caps = report.profile.capabilities
    .filter((item) => item.present === true)
    .map((item) => `<li>${esc(item.id)}</li>`)
    .join("");
  const limits = report.limitations.map((item) => `<li>${esc(item.detail)}</li>`).join("");
  const withheld = report.withheld.map((item) => `<li><code>${esc(item.ruleId)}</code> — ${esc(item.reason)} <a href="${esc(item.sourceUrl)}">${esc(item.sourceSection)}</a></li>`).join("");
  const unknowns = report.profile.unknowns.map((item) => `<li>${esc(item)}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(report.product)} report — ${esc(report.verdictHeadline)}</title>
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
</style>
</head>
<body>
<main>
  <p class="meta">${esc(report.product)} by ${esc(report.vendor)} · ${esc(report.toolVersion)} · pack ${esc(report.pack.version)}</p>
  <h1>${esc(report.profile.displayName ?? report.profile.name ?? "Untitled app")}</h1>
  <p class="meta">${esc(report.profile.framework)} · iOS ${esc(yes(report.profile.platforms.ios))} · Android ${esc(yes(report.profile.platforms.android))} · ${report.offline ? "offline" : "live checks on"}</p>
  <p class="verdict ${verdictClass}">${esc(report.verdictHeadline)}</p>
  ${report.disclaimers.map((item) => `<p class="disclaimer">${esc(item)}</p>`).join("\n  ")}
  <h2>Why</h2>
  <ul>${report.verdictBecause.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
  <h2>Capabilities found</h2>
  ${caps ? `<ul>${caps}</ul>` : "<p>No mapped capabilities were found.</p>"}
  <h2>Findings</h2>
  ${findings || "<p>No applicable findings.</p>"}
  <h2>Limits of this scan</h2>
  <ul>${limits}</ul>
  ${unknowns ? `<h2>Could not read</h2><ul>${unknowns}</ul>` : ""}
  <h2>Rules withheld pending verification</h2>
  ${withheld ? `<ul>${withheld}</ul>` : "<p>None.</p>"}
  <p class="meta">Generated ${esc(report.generatedAt)}. This file does not load remote scripts or styles.</p>
</main>
</body>
</html>
`;
}

function findingHtml(finding: Finding): string {
  const evidence = finding.evidence.length
    ? `<ul>${finding.evidence.map((item) => `<li>${esc(item.path ?? item.kind)}${item.line ? `:${item.line}` : ""} — ${esc(item.detail)}</li>`).join("")}</ul>`
    : "<p>No file or link evidence was attached.</p>";
  return `<article>
  <p class="tag ${esc(finding.status)}">${esc(finding.status)} · ${esc(finding.severity)} · ${esc(finding.ruleId)}${finding.stale ? " · stale" : ""}</p>
  <h3>${esc(finding.title)}</h3>
  <p>${esc(finding.summaryEn)}</p>
  ${finding.nextEn ? `<p>Next: ${esc(finding.nextEn)}</p>` : ""}
  <p>${esc(finding.summaryTr)}</p>
  <p>Source: <a href="${esc(finding.sourceUrl)}">${esc(finding.sourcePublisher)} ${esc(finding.sourceSection)}</a>${finding.verifiedAt ? ` · verified ${esc(finding.verifiedAt)}` : ""}</p>
  <p>${esc(finding.checkNote)}</p>
  ${evidence}
</article>`;
}

function formatFinding(finding: Finding, lang: "en" | "tr"): string[] {
  const summary = lang === "tr" ? finding.summaryTr : finding.summaryEn;
  const next = lang === "tr" ? finding.nextTr : finding.nextEn;
  const lines = [
    `${finding.status.toUpperCase()}  ${finding.severity.toUpperCase()}  ${finding.title}`,
    `  ${summary}`,
    ...(next ? [`  Next: ${next}`] : []),
    `  Rule: ${finding.ruleId}`,
    `  Source: ${finding.sourcePublisher} ${finding.sourceSection}`,
    `  ${finding.sourceUrl}`,
    `  Verified: ${finding.verifiedAt ?? "not verified"}${finding.stale ? " (stale)" : ""}`,
    `  Check: ${finding.checkNote}`,
  ];
  if (finding.evidence.length === 0) lines.push("  Evidence: none attached");
  for (const item of finding.evidence) {
    const where = item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : item.kind;
    lines.push(`  Evidence: ${where} — ${item.detail}`);
  }
  return lines;
}

function byImportance(left: Finding, right: Finding): number {
  const statusRank = { fail: 0, unchecked: 1, pass: 2, not_applicable: 3 };
  const severityRank = { blocker: 0, risk: 1, info: 2 };
  return statusRank[left.status] - statusRank[right.status] || severityRank[left.severity] - severityRank[right.severity];
}

function yes(value: boolean): string {
  return value ? "yes" : "no";
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
