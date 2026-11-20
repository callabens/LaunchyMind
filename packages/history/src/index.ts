import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { LaunchReport } from "../../core/src/index.ts";
import { projectSchema } from "../../scan/src/index.ts";
import { blocksReady } from "../../verdict/src/index.ts";

export interface HistoryBlocker {
  ruleId: string | null;
  title: string;
  severity: string | null;
}

export interface HistoryEntry {
  toolVersion: string;
  generatedAt: string;
  verdict: string;
  headline: string;
  blockers: HistoryBlocker[];
}

export interface RecordedFix {
  appliedAt: string;
  ruleId: string;
}

export async function historyEnabled(projectPath: string): Promise<boolean> {
  const path = join(projectPath, ".launchymind", "project.yaml");
  if (!existsSync(path)) return false;
  const parsed = projectSchema.safeParse(parse(await readFile(path, "utf8")));
  return parsed.success && parsed.data.history === true;
}

export function summarize(report: LaunchReport): HistoryEntry {
  return {
    toolVersion: report.toolVersion,
    generatedAt: report.generatedAt,
    verdict: report.verdict,
    headline: report.verdictHeadline,
    blockers: blocksReady(report.findings, report.limitations).map((item) => ({
      ruleId: item.ruleId,
      title: item.title,
      severity: item.severity,
    })),
  };
}

export async function saveHistoryIfEnabled(projectPath: string, report: LaunchReport): Promise<boolean> {
  if (!(await historyEnabled(projectPath))) return false;
  const directory = join(projectPath, ".launchymind", "history");
  await mkdir(directory, { recursive: true });
  const stamp = report.generatedAt.replace(/:/g, "-");
  let file = join(directory, `${stamp}.json`);
  let suffix = 2;
  while (existsSync(file)) {
    file = join(directory, `${stamp}-${suffix}.json`);
    suffix += 1;
  }
  await writeFile(file, `${JSON.stringify(summarize(report), null, 2)}\n`, "utf8");
  return true;
}

export async function readHistory(projectPath: string): Promise<HistoryEntry[]> {
  const directory = join(projectPath, ".launchymind", "history");
  if (!existsSync(directory)) return [];
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const entries: HistoryEntry[] = [];
  for (const name of names) {
    const document = JSON.parse(await readFile(join(directory, name), "utf8")) as HistoryEntry;
    if (document && typeof document.generatedAt === "string" && typeof document.verdict === "string") entries.push(document);
  }
  return entries;
}

export async function recordFixIfEnabled(projectPath: string, ruleId: string, appliedAt: string): Promise<void> {
  if (!(await historyEnabled(projectPath))) return;
  const directory = join(projectPath, ".launchymind", "history");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "fixes.jsonl");
  const line = `${JSON.stringify({ appliedAt, ruleId } satisfies RecordedFix)}\n`;
  const previous = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, `${previous}${line}`, "utf8");
}

export async function readFixes(projectPath: string): Promise<RecordedFix[]> {
  const path = join(projectPath, ".launchymind", "history", "fixes.jsonl");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const item = JSON.parse(line) as RecordedFix;
    if (typeof item.ruleId !== "string") return [];
    return [item];
  });
}

export function renderHistory(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return "No saved scans. History is written only when project.yaml sets history: true.";
  const lines = ["Saved scans, oldest first."];
  for (const entry of entries) lines.push(`${entry.generatedAt}  ${entry.verdict}  blockers ${entry.blockers.length}`);
  const verdicts = entries.map((entry) => entry.verdict).join(" -> ");
  lines.push(`Trend: ${verdicts}`);
  return lines.join("\n");
}

export function clearedBlockers(entries: readonly HistoryEntry[]): string[] {
  if (entries.length < 2) return [];
  const latest = new Set(entries[entries.length - 1]?.blockers.map((item) => item.ruleId).filter((id): id is string => Boolean(id)));
  const seen = new Set<string>();
  for (const entry of entries.slice(0, -1)) {
    for (const blocker of entry.blockers) {
      if (blocker.ruleId && !latest.has(blocker.ruleId)) seen.add(blocker.ruleId);
    }
  }
  return [...seen].sort();
}

export function renderDashboard(entries: readonly HistoryEntry[], fixes: readonly RecordedFix[]): string {
  const latest = entries[entries.length - 1];
  const points = entries.map((entry) => `${entry.generatedAt.slice(0, 16)} ${entry.verdict} (${entry.blockers.length})`).join(" · ");
  const open = latest ? latest.blockers.map((item) => `<li><code>${esc(item.ruleId ?? item.title)}</code> ${esc(item.title)}</li>`).join("") : "";
  const cleared = clearedBlockers(entries).map((id) => `<li><code>${esc(id)}</code></li>`).join("");
  const applied = fixes.map((item) => `<li><code>${esc(item.ruleId)}</code> ${esc(item.appliedAt)}</li>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'">
<title>LaunchyMind history</title>
<style>
  body { margin: 0; font: 16px/1.5 Georgia, serif; background: #f7f4ee; color: #1c1915; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 2rem; margin: 0 0 8px; }
  .note { color: #4a453d; }
  ul { padding-left: 1.2rem; }
  code { font: 13px ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <h1>LaunchyMind</h1>
  <p class="note">Local history. This page does not load a script, a font, or a tracker.</p>
  <h2>Verdict over time</h2>
  <p>${entries.length === 0 ? "No saved scans." : esc(points)}</p>
  <h2>Open blockers</h2>
  <ul>${open || "<li>None in the latest saved scan.</li>"}</ul>
  <h2>Blockers that cleared</h2>
  <ul>${cleared || "<li>None.</li>"}</ul>
  <h2>Fixes applied</h2>
  <p class="note">These are fixes LaunchyMind wrote after an explicit yes, and only while history is on.</p>
  <ul>${applied || "<li>None recorded.</li>"}</ul>
</main>
</body>
</html>
`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char);
}
