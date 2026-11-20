import { translator, type Locale } from "../../i18n/src/index.ts";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { existsSync } from "node:fs";
import type { FactValue, LaunchReport } from "../../core/src/index.ts";

export interface SdkDataItem {
  type: string;
  tracking: boolean;
  purposes: string[];
  note: string;
  source?: string;
}

export interface SdkEntry {
  id: string;
  names: string[];
  vendor: string;
  disclosure: "verified" | "unknown";
  verifiedAt: string;
  source: string;
  section: string;
  note?: string;
  apple: SdkDataItem[];
  play: Array<Omit<SdkDataItem, "tracking"> & { tracking?: boolean }>;
}

export interface LabelDraft {
  draft: true;
  notLegalAdvice: true;
  notAStoreSubmission: true;
  generatedFrom: string;
  apple: { en: string; tr: string; items: Array<{ sdk: string; type: string; purposes: string[]; tracking: boolean; evidence: string; source: string; verifiedAt: string }> };
  play: { en: string; tr: string; items: Array<{ sdk: string; type: string; purposes: string[]; evidence: string; source: string; verifiedAt: string }> };
  unknownSdks: Array<{ id: string; names: string[]; reason: string }>;
  unmatchedPackages: string[];
}

const DRAFT_EN = "DRAFT. This is not a finished App Privacy or Data safety form, not store approval, and not legal advice. Each row is only what a vendor page said about that SDK.";
const DRAFT_TR = "TASLAK. Bu, bitmiş bir Uygulama Gizliliği veya Veri güvenliği formu, mağaza onayı veya hukuk görüşü değildir. Her satır yalnızca bir satıcının sayfasında o SDK için yazılan bilgidir.";

export function findSdkPackPath(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "packages", "packs", "sdk", "sdks.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("SDK knowledge base was not found at packages/packs/sdk/sdks.yaml.");
}

export async function loadSdkBase(path = findSdkPackPath()): Promise<SdkEntry[]> {
  const document = parse(await readFile(path, "utf8")) as { sdks?: unknown[] };
  return (document.sdks ?? []).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as SdkEntry;
    if (!item.id || !Array.isArray(item.names)) return [];
    return [item];
  });
}

export function draftLabels(packageNames: readonly string[], base: readonly SdkEntry[]): LabelDraft {
  const names = new Set(packageNames);
  const matched = base.filter((sdk) => sdk.names.some((name) => names.has(name)));
  const knownIds = new Set(base.flatMap((sdk) => sdk.names));
  const apple = [];
  const play = [];
  const unknownSdks = [];
  for (const sdk of matched) {
    if (sdk.disclosure !== "verified" || !sdk.source.startsWith("https://")) {
      unknownSdks.push({ id: sdk.id, names: sdk.names.filter((name) => names.has(name)), reason: sdk.note ?? "No verified vendor disclosure is recorded." });
      continue;
    }
    for (const item of sdk.apple ?? []) {
      apple.push({
        sdk: sdk.id,
        type: item.type,
        purposes: item.purposes,
        tracking: item.tracking,
        evidence: item.note,
        source: item.source && item.source.startsWith("https://") ? item.source : sdk.source,
        verifiedAt: sdk.verifiedAt,
      });
    }
    for (const item of sdk.play ?? []) {
      play.push({
        sdk: sdk.id,
        type: item.type,
        purposes: item.purposes,
        evidence: item.note,
        source: item.source && item.source.startsWith("https://") ? item.source : sdk.source,
        verifiedAt: sdk.verifiedAt,
      });
    }
  }
  return {
    draft: true,
    notLegalAdvice: true,
    notAStoreSubmission: true,
    generatedFrom: "packages/packs/sdk/sdks.yaml",
    apple: { en: DRAFT_EN, tr: DRAFT_TR, items: apple },
    play: { en: DRAFT_EN, tr: DRAFT_TR, items: play },
    unknownSdks,
    unmatchedPackages: [...names].filter((name) => !knownIds.has(name)).sort(),
  };
}

export function sdkFacts(draft: LabelDraft, facts: Record<string, FactValue>): Record<string, FactValue> {
  const verified = draft.apple.items.length + draft.play.items.length > 0;
  const recognized = verified || draft.unknownSdks.length > 0;
  if (!recognized) {
    return { "sdk.coverage": "none", "sdk.manifest_mismatch": "not-applicable", "sdk.answer_mismatch": "not-applicable" };
  }
  const coverage = verified && draft.unknownSdks.length === 0 ? "covered" : verified ? "partial" : "none";
  const tracks = draft.apple.items.some((item) => item.tracking);
  let manifest: FactValue = "not-applicable";
  if (tracks) {
    const flag = facts["ios.privacy_manifest.tracking"];
    if (facts["ios.privacy_manifest.present"] !== true || flag === "unknown") manifest = "unknown";
    else manifest = flag === "false" ? "yes" : "no";
  }
  const deviceIdTypes = new Set(["Device ID", "Device or other IDs", "Device or other identifiers", "Device and Account identifiers"]);
  const collectsDeviceId = [...draft.apple.items, ...draft.play.items].some((item) => deviceIdTypes.has(item.type));
  let answer: FactValue = "not-applicable";
  if (collectsDeviceId) {
    const stated = facts["attestation.google.data_safety_ad_id"];
    if (stated === "unknown") answer = "unknown";
    else answer = stated === "no" ? "yes" : "no";
  }
  return { "sdk.coverage": coverage, "sdk.manifest_mismatch": manifest, "sdk.answer_mismatch": answer };
}

export function renderLabels(draft: LabelDraft, lang: Locale): string {
  const t = translator(lang);
  const lines = [lang === "tr" ? draft.apple.tr : lang === "en" ? draft.apple.en : t("labels.draft"), ""];
  lines.push(t("labels.apple"));
  if (draft.apple.items.length === 0) lines.push(t("labels.no_row"));
  for (const item of draft.apple.items) {
    lines.push(`- ${item.sdk}: ${item.type}; ${item.purposes.join(", ")}; ${t("labels.tracking")} ${item.tracking ? t("word.yes") : t("word.no")}`);
    lines.push(`  ${item.evidence}`);
    lines.push(`  ${item.source} (${item.verifiedAt})`);
  }
  lines.push("");
  lines.push(t("labels.play"));
  if (draft.play.items.length === 0) lines.push(t("labels.no_row"));
  for (const item of draft.play.items) {
    lines.push(`- ${item.sdk}: ${item.type}; ${item.purposes.join(", ")}`);
    lines.push(`  ${item.evidence}`);
    lines.push(`  ${item.source} (${item.verifiedAt})`);
  }
  if (draft.unknownSdks.length) {
    lines.push("");
    lines.push(t("labels.unknown"));
    for (const sdk of draft.unknownSdks) lines.push(`- ${sdk.id}: ${sdk.reason}`);
  }
  return lines.join("\n");
}

export async function labelsForReport(report: LaunchReport): Promise<LabelDraft> {
  const names = report.profile.dependencies.map((item) => item.name);
  return draftLabels(names, await loadSdkBase());
}
