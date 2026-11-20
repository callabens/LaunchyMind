import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { findCorePackDir, type SourceWatchItem } from "../../core/src/index.ts";
import { loadPack } from "../../rules/src/index.ts";

export interface SourceRef {
  ruleId: string;
  url: string;
}

export interface SourceSample {
  at: number;
  hash: string;
  excerpt: string;
}

export interface BaselineEntry {
  url: string;
  contentHash: string;
  verifiedAt: string;
  samples: SourceSample[];
  /** Set when a script cannot read the page (for example a bot challenge) and a person hashed it from a browser. */
  note?: string;
}

export interface BaselineFile {
  format: 1;
  sources: BaselineEntry[];
}

export interface SourceResult {
  url: string;
  ruleIds: string[];
  status: "unchanged" | "changed" | "broken" | "unbaselined";
  contentHash: string | null;
  storedHash: string | null;
  excerpt: string;
  error: string | null;
  samples: SourceSample[];
}

export interface SourceReport {
  checkedAt: string;
  results: SourceResult[];
  changed: number;
  broken: number;
  unbaselined: number;
  unchanged: number;
}

const SAMPLE_AT = [0, 0.12, 0.25, 0.37, 0.5, 0.62, 0.75, 0.87];

export function normalizePage(body: string): string {
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

export function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function pageSamples(text: string): SourceSample[] {
  return SAMPLE_AT.map((at) => {
    const start = Math.min(text.length, Math.floor(text.length * at));
    const excerpt = text.slice(start, start + 160);
    return { at, hash: contentHash(excerpt), excerpt };
  });
}

export function emptyBaseline(): BaselineFile {
  return { format: 1, sources: [] };
}

export async function readBaseline(path: string): Promise<BaselineFile> {
  if (!existsSync(path)) return emptyBaseline();
  const document = parse(await readFile(path, "utf8")) as { format?: number; sources?: BaselineEntry[] };
  if (document.format !== 1 || !Array.isArray(document.sources)) throw new Error("Source baseline is not format 1.");
  return { format: 1, sources: document.sources.filter((item) => item.contentHash !== EMPTY_PAGE_HASH) };
}

export async function writeBaseline(path: string, baseline: BaselineFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `# Hashes of normalized source pages. A changed hash flags needs re-verify.\n# This file does not change rule text.\n${stringify(baseline)}`;
  await writeFile(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

export function findPackRoot(): string {
  return join(findCorePackDir(), "..");
}

export function defaultBaselinePath(): string {
  return join(findPackRoot(), "source-watch", "baseline.yaml");
}

/** Hash of an empty page. A stored entry with this hash never proved anything and is dropped on read. */
export const EMPTY_PAGE_HASH = contentHash("");

export async function listRuleSources(packRoot = findPackRoot()): Promise<SourceRef[]> {
  const dirs = [join(packRoot, "core")];
  const legal = join(packRoot, "legal");
  if (existsSync(legal)) {
    for (const name of await readdir(legal)) {
      if (existsSync(join(legal, name, "pack.yaml"))) dirs.push(join(legal, name));
    }
  }
  const rows: SourceRef[] = [];
  for (const dir of dirs) {
    const pack = await loadPack(dir);
    for (const rule of [...pack.rules, ...pack.withheld]) rows.push({ ruleId: rule.id, url: rule.source.url });
  }
  rows.push(...(await listSdkSources(join(packRoot, "sdk", "sdks.yaml"))));
  return rows;
}

/** Vendor pages behind SDK draft rows are watched like rule sources. The id is sdk:<id>. */
export async function listSdkSources(path: string): Promise<SourceRef[]> {
  if (!existsSync(path)) return [];
  const document = parse(await readFile(path, "utf8")) as { sdks?: Array<{ id?: string; source?: string; apple?: Array<{ source?: string }>; play?: Array<{ source?: string }> }> };
  const rows: SourceRef[] = [];
  for (const sdk of document.sdks ?? []) {
    if (!sdk?.id) continue;
    const urls = new Set<string>();
    if (sdk.source?.startsWith("https://")) urls.add(sdk.source);
    for (const item of [...(sdk.apple ?? []), ...(sdk.play ?? [])]) {
      if (item?.source?.startsWith("https://")) urls.add(item.source);
    }
    for (const url of urls) rows.push({ ruleId: `sdk:${sdk.id}`, url });
  }
  return rows;
}

function group(sources: readonly SourceRef[]): Map<string, string[]> {
  const urls = new Map<string, string[]>();
  for (const source of sources) {
    const ids = urls.get(source.url) ?? [];
    ids.push(source.ruleId);
    urls.set(source.url, ids);
  }
  return urls;
}

function diffExcerpt(stored: BaselineEntry | undefined, fresh: readonly SourceSample[]): string {
  if (!stored) return "";
  const lines: string[] = [];
  for (const sample of fresh) {
    const previous = stored.samples.find((item) => item.at === sample.at);
    if (!previous || previous.hash === sample.hash) continue;
    lines.push(`at ${sample.at}: was "${previous.excerpt}" now "${sample.excerpt}"`);
    if (lines.length === 3) break;
  }
  if (lines.length === 0) return "The normalized hash changed and the saved excerpts still match, so the difference is outside those excerpts.";
  return lines.join("\n");
}

async function checkOne(url: string, ruleIds: string[], baseline: BaselineFile, fetchImpl: typeof fetch): Promise<SourceResult> {
  const stored = baseline.sources.find((item) => item.url === url);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "LaunchyMind", "accept-language": "en-US,en;q=0.8" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return { url, ruleIds, status: "broken", contentHash: null, storedHash: stored?.contentHash ?? null, excerpt: "", error: `${message}${cause}`, samples: [] };
  }
  if (!response.ok) {
    return { url, ruleIds, status: "broken", contentHash: null, storedHash: stored?.contentHash ?? null, excerpt: "", error: `HTTP ${response.status}`, samples: [] };
  }
  const text = normalizePage(await response.text());
  if (response.status !== 200 || text.length === 0) {
    const reason = response.headers.get("x-amzn-waf-action") ? "a bot challenge" : "an empty page";
    return { url, ruleIds, status: "broken", contentHash: null, storedHash: stored?.contentHash ?? null, excerpt: "", error: `HTTP ${response.status} returned ${reason}, so the page text could not be hashed. Open it in a browser.`, samples: [] };
  }
  const hash = contentHash(text);
  const samples = pageSamples(text);
  if (!stored) return { url, ruleIds, status: "unbaselined", contentHash: hash, storedHash: null, excerpt: "", error: null, samples };
  const changed = stored.contentHash !== hash;
  return {
    url,
    ruleIds,
    status: changed ? "changed" : "unchanged",
    contentHash: hash,
    storedHash: stored.contentHash,
    excerpt: changed ? diffExcerpt(stored, samples) : "",
    error: null,
    samples,
  };
}

export async function checkSources(input: {
  sources: readonly SourceRef[];
  baseline: BaselineFile;
  fetchImpl: typeof fetch;
  now: Date;
}): Promise<SourceReport> {
  const pairs = [...group(input.sources)];
  const results: SourceResult[] = new Array(pairs.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pairs.length) {
      const index = cursor;
      cursor += 1;
      const pair = pairs[index];
      if (!pair) return;
      results[index] = await checkOne(pair[0], pair[1], input.baseline, input.fetchImpl);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, pairs.length) }, () => worker()));
  const count = (status: SourceResult["status"]) => results.filter((item) => item.status === status).length;
  return {
    checkedAt: input.now.toISOString(),
    results,
    changed: count("changed"),
    broken: count("broken"),
    unbaselined: count("unbaselined"),
    unchanged: count("unchanged"),
  };
}

/** Adds hashes only for URLs that have none. Never replaces a stored hash and never edits a rule. */
export function withNewHashes(baseline: BaselineFile, report: SourceReport, verifiedAt: string): BaselineFile {
  const sources = baseline.sources.map((item) => ({ ...item, samples: item.samples.map((sample) => ({ ...sample })) }));
  for (const result of report.results) {
    if (result.status !== "unbaselined" || !result.contentHash) continue;
    if (sources.some((item) => item.url === result.url)) continue;
    sources.push({ url: result.url, contentHash: result.contentHash, verifiedAt, samples: result.samples });
  }
  return { format: 1, sources };
}

export function needsReverify(report: SourceReport): SourceWatchItem[] {
  const items: SourceWatchItem[] = [];
  for (const result of report.results) {
    if (result.status !== "changed") continue;
    for (const ruleId of result.ruleIds) items.push({ ruleId, url: result.url, excerpt: result.excerpt });
  }
  return items;
}

export function renderSourceReport(report: SourceReport): string {
  const lines = [
    `Source check ${report.checkedAt}`,
    `Unchanged ${report.unchanged}. Changed ${report.changed}. Broken ${report.broken}. No stored hash ${report.unbaselined}.`,
    "A changed source is flagged for a human to re-verify. Rule text is not edited.",
  ];
  for (const result of report.results) {
    if (result.status === "unchanged") continue;
    lines.push("", `${result.status} ${result.url}`, `rules: ${result.ruleIds.join(", ")}`);
    if (result.error) lines.push(result.error);
    if (result.excerpt) lines.push(result.excerpt);
  }
  return lines.join("\n");
}

export async function readProjectSourceStatus(projectPath: string): Promise<SourceWatchItem[]> {
  const path = join(projectPath, ".launchymind", "source-status.json");
  if (!existsSync(path)) return [];
  const document = JSON.parse(await readFile(path, "utf8")) as { needsReverify?: SourceWatchItem[] };
  if (!Array.isArray(document.needsReverify)) return [];
  return document.needsReverify.flatMap((item) => {
    if (!item || typeof item.ruleId !== "string" || typeof item.url !== "string") return [];
    return [{ ruleId: item.ruleId, url: item.url, excerpt: typeof item.excerpt === "string" ? item.excerpt : "" }];
  });
}

export async function writeProjectSourceStatus(projectPath: string, items: readonly SourceWatchItem[], checkedAt: string): Promise<void> {
  const path = join(projectPath, ".launchymind", "source-status.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ checkedAt, needsReverify: items }, null, 2)}\n`, "utf8");
}
