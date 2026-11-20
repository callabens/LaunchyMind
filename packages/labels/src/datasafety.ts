import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LabelDraft } from "./index.ts";

/**
 * Local Play Data safety declaration. The Play Developer API method for Data
 * safety is write-only, so the developer keeps their answers in this file and
 * LaunchyMind compares it with the verified SDK rows. It is not uploaded.
 */
export const DATA_SAFETY_FILE = "launchymind.datasafety.json";

/** Data types as Play Console names them on answer 10787469. */
export const PLAY_DATA_TYPES = [
  "Approximate location", "Precise location",
  "Name", "Email address", "User IDs", "Address", "Phone number", "Race and ethnicity", "Political or religious beliefs", "Sexual orientation", "Other info",
  "User payment info", "Purchase history", "Credit score", "Other financial info",
  "Health info", "Fitness info",
  "Emails", "SMS or MMS", "Other in-app messages",
  "Photos", "Videos",
  "Voice or sound recordings", "Music files", "Other audio files",
  "Files and docs", "Calendar events", "Contacts",
  "App interactions", "In-app search history", "Installed apps", "Other user-generated content", "Other actions",
  "Web browsing history",
  "Crash logs", "Diagnostics", "Other app performance data",
  "Device or other IDs",
] as const;

const typeSchema = z.enum(PLAY_DATA_TYPES);

export const dataSafetySchema = z.object({
  format: z.literal(1),
  reviewed: z.boolean(),
  collectsOrShares: z.boolean(),
  types: z.array(z.object({
    type: typeSchema,
    collected: z.boolean(),
    shared: z.boolean(),
    optional: z.boolean().optional(),
    purposes: z.array(z.string().min(1)).default([]),
    note: z.string().optional(),
  }).strict()).default([]),
}).strict();

export type DataSafetyDeclaration = z.infer<typeof dataSafetySchema>;

/**
 * Vendor wording from sdks.yaml mapped to a Play data type only when the
 * vendor page used the Play name or an unambiguous equivalent. Anything else
 * is reported as needing a manual mapping, never as a mismatch.
 */
const VENDOR_TO_PLAY: Record<string, (typeof PLAY_DATA_TYPES)[number]> = {
  "approximate location": "Approximate location",
  "purchase history": "Purchase history",
  "app interactions": "App interactions",
  "user product interactions": "App interactions",
  "other actions": "Other actions",
  "diagnostics": "Diagnostics",
  "diagnostic information": "Diagnostics",
  "crash logs": "Crash logs",
  "device or other ids": "Device or other IDs",
  "device or other identifiers": "Device or other IDs",
  "device and account identifiers": "Device or other IDs",
};

export function playTypeFor(vendorType: string): (typeof PLAY_DATA_TYPES)[number] | null {
  return VENDOR_TO_PLAY[vendorType.trim().toLowerCase()] ?? null;
}

export interface DataSafetyComparison {
  status: "match" | "mismatch" | "missing" | "unreviewed" | "invalid";
  missingTypes: Array<{ type: string; sdks: string[] }>;
  unmapped: Array<{ sdk: string; type: string }>;
  problems: string[];
}

export async function readDataSafety(projectPath: string): Promise<{ declaration: DataSafetyDeclaration | null; problems: string[]; present: boolean }> {
  const path = join(projectPath, DATA_SAFETY_FILE);
  if (!existsSync(path)) return { declaration: null, problems: [], present: false };
  try {
    const parsed = dataSafetySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return { declaration: null, problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), present: true };
    return { declaration: parsed.data, problems: [], present: true };
  } catch (error) {
    return { declaration: null, problems: [error instanceof Error ? error.message : "Unreadable JSON."], present: true };
  }
}

export function compareDataSafety(declaration: DataSafetyDeclaration | null, present: boolean, problems: string[], draft: LabelDraft): DataSafetyComparison {
  if (!present) return { status: "missing", missingTypes: [], unmapped: [], problems: [] };
  if (!declaration) return { status: "invalid", missingTypes: [], unmapped: [], problems };
  const unmapped: DataSafetyComparison["unmapped"] = [];
  const needed = new Map<string, Set<string>>();
  for (const item of draft.play.items) {
    const type = playTypeFor(item.type);
    if (!type) {
      unmapped.push({ sdk: item.sdk, type: item.type });
      continue;
    }
    const sdks = needed.get(type) ?? new Set<string>();
    sdks.add(item.sdk);
    needed.set(type, sdks);
  }
  if (!declaration.reviewed) return { status: "unreviewed", missingTypes: [], unmapped, problems: ["reviewed is false. Review every row, then set reviewed to true."] };
  const declared = new Set(declaration.collectsOrShares ? declaration.types.filter((item) => item.collected || item.shared).map((item) => item.type) : []);
  const missingTypes = [...needed].filter(([type]) => !declared.has(type as (typeof PLAY_DATA_TYPES)[number])).map(([type, sdks]) => ({ type, sdks: [...sdks].sort() }));
  return { status: missingTypes.length === 0 ? "match" : "mismatch", missingTypes, unmapped, problems: [] };
}

/** A starting file built only from verified SDK rows. reviewed stays false until a person edits it. */
export function templateFromDraft(draft: LabelDraft): DataSafetyDeclaration {
  const types = new Map<string, { purposes: Set<string>; sdks: Set<string> }>();
  for (const item of draft.play.items) {
    const type = playTypeFor(item.type);
    if (!type) continue;
    const row = types.get(type) ?? { purposes: new Set<string>(), sdks: new Set<string>() };
    for (const purpose of item.purposes) row.purposes.add(purpose);
    row.sdks.add(item.sdk);
    types.set(type, row);
  }
  return {
    format: 1,
    reviewed: false,
    collectsOrShares: types.size > 0,
    types: [...types].map(([type, row]) => ({
      type: type as (typeof PLAY_DATA_TYPES)[number],
      collected: true,
      shared: false,
      purposes: [...row.purposes],
      note: `Draft from verified SDK rows: ${[...row.sdks].join(", ")}. Set shared, optional, and purposes from your own setup.`,
    })),
  };
}

export async function writeDataSafetyTemplate(projectPath: string, draft: LabelDraft): Promise<{ path: string; wrote: boolean }> {
  const path = join(projectPath, DATA_SAFETY_FILE);
  if (existsSync(path)) return { path, wrote: false };
  await writeFile(path, `${JSON.stringify(templateFromDraft(draft), null, 2)}\n`, "utf8");
  return { path, wrote: true };
}

const csvCell = (value: string): string => /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;

/** A review sheet, not the Play Console import format. */
export function dataSafetyCsv(draft: LabelDraft): string {
  const rows = [["draft", "play_data_type", "vendor_wording", "sdk", "purposes", "source", "verified_at"]];
  for (const item of draft.play.items) {
    rows.push(["DRAFT", playTypeFor(item.type) ?? "needs manual mapping", item.type, item.sdk, item.purposes.join("; "), item.source, item.verifiedAt]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
