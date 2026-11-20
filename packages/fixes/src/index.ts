import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stdin, stdout } from "node:process";
import { LAWYER_WARNING, type FactValue, type LaunchReport, type Verdict } from "../../core/src/index.ts";
import { runScan } from "../../pipeline/src/index.ts";

export interface FileEdit {
  path: string;
  before: string;
  after: string;
}

export interface FixProposal {
  ruleId: string;
  fixId: string | null;
  writesFiles: false;
  canApply: boolean;
  available: boolean;
  warning: string | null;
  summary: string;
  draft: string;
  diff: string;
}

export interface ApplyResult {
  status: "APPLIED" | "DRY_RUN" | "BLOCKED" | "REFUSED";
  writesFiles: boolean;
  reason: string;
  ruleId: string;
  fixId: string | null;
  diff: string;
  before: { verdict: Verdict; headline: string } | null;
  after: { verdict: Verdict; headline: string } | null;
}

const PROPOSE_ONLY = new Set([
  "apple.privacy-policy-in-app",
  "apple.privacy-policy-content",
  "apple.account-deletion",
  "google.account-deletion",
  "iab.app-ads",
  "kvkk.disclosure",
]);

const USAGE_KEYS: Record<string, { key: string; sentence: string }> = {
  "apple.permission-camera": {
    key: "NSCameraUsageDescription",
    sentence: "Replace this placeholder with the specific reason this app uses the camera before you submit.",
  },
  "apple.permission-photos": {
    key: "NSPhotoLibraryUsageDescription",
    sentence: "Replace this placeholder with the specific reason this app uses the photo library before you submit.",
  },
  "apple.permission-location": {
    key: "NSLocationWhenInUseUsageDescription",
    sentence: "Replace this placeholder with the specific reason this app uses location before you submit.",
  },
  "apple.permission-microphone": {
    key: "NSMicrophoneUsageDescription",
    sentence: "Replace this placeholder with the specific reason this app uses the microphone before you submit.",
  },
  "apple.permission-contacts": {
    key: "NSContactsUsageDescription",
    sentence: "Replace this placeholder with the specific reason this app uses contacts before you submit.",
  },
  "apple.tracking-permission": {
    key: "NSUserTrackingUsageDescription",
    sentence: "Replace this placeholder with the specific reason this app asks to track before you submit.",
  },
};

const COLLECTED_TYPES = [
  "NSPrivacyCollectedDataTypeDeviceID",
  "NSPrivacyCollectedDataTypeAdvertisingData",
];

export function resolveProjectFile(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Refusing to write outside the project root: ${relativePath}`);
  }
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to write outside the project root: ${relativePath}`);
  }
  const back = relative(resolvedRoot, target);
  if (back.startsWith("..") || isAbsolute(back)) {
    throw new Error(`Refusing to write outside the project root: ${relativePath}`);
  }
  return target;
}

export async function proposeFix(report: LaunchReport, ruleId: string): Promise<FixProposal> {
  const plan = await planFix(report.projectPath, report, ruleId);
  return {
    ruleId,
    fixId: plan.fixId,
    writesFiles: false,
    canApply: plan.edits.length > 0,
    available: plan.available,
    warning: plan.warning,
    summary: plan.summary,
    draft: plan.draft,
    diff: plan.diff,
  };
}

export async function applyApprovedFix(options: {
  projectPath: string;
  ruleId: string;
  fixId?: string | null;
  approved: boolean;
  dryRun: boolean;
  allowDirty: boolean;
  offline?: boolean;
  requireOperator?: boolean;
  operatorEnabled?: boolean;
  confirm?: boolean;
  requireFixId?: boolean;
}): Promise<ApplyResult> {
  const projectPath = resolve(options.projectPath);
  const before = await runScan(projectPath, { offline: options.offline === true });
  const plan = await planFix(projectPath, before, options.ruleId);
  const base = {
    ruleId: options.ruleId,
    fixId: plan.fixId,
    diff: plan.diff,
    before: { verdict: before.verdict, headline: before.verdictHeadline },
    after: null,
  };
  if (options.requireOperator && options.operatorEnabled !== true) {
    return { ...base, status: "BLOCKED", writesFiles: false, reason: "apply_fix is off. Start the MCP server with LAUNCHYMIND_ALLOW_APPLY=1. No file was changed." };
  }
  if (!plan.fixId || plan.edits.length === 0) {
    return { ...base, status: "REFUSED", writesFiles: false, reason: plan.summary || "This finding has no deterministic file edit. No file was changed." };
  }
  if ((options.fixId !== undefined && options.fixId !== plan.fixId) || (options.requireFixId && options.fixId !== plan.fixId)) {
    return { ...base, status: "REFUSED", writesFiles: false, reason: "The fix id does not match the plan from propose_fix. No file was changed." };
  }
  if (options.dryRun) {
    return { ...base, status: "DRY_RUN", writesFiles: false, reason: "Dry run. The diff is above and no file was changed." };
  }
  if (options.confirm) {
    if (!stdin.isTTY) {
      return { ...base, status: "BLOCKED", writesFiles: false, reason: "Refusing to write without --yes when there is no interactive terminal. No file was changed." };
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Apply this fix? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      return { ...base, status: "BLOCKED", writesFiles: false, reason: "Fix was not approved. No file was changed." };
    }
  } else if (!options.approved) {
    return { ...base, status: "BLOCKED", writesFiles: false, reason: "Refusing to write without explicit approval. No file was changed." };
  }
  const dirty = gitDirty(projectPath);
  if (dirty === true && !options.allowDirty) {
    return { ...base, status: "REFUSED", writesFiles: false, reason: "The git tree has uncommitted changes. Re-run with --allow-dirty to write anyway. No file was changed." };
  }
  await applyEdits(projectPath, plan.edits);
  const after = await runScan(projectPath, { offline: options.offline === true });
  return {
    ...base,
    status: "APPLIED",
    writesFiles: true,
    reason: `Wrote ${plan.edits.length} file(s). Verdict ${before.verdictHeadline} -> ${after.verdictHeadline}.`,
    after: { verdict: after.verdict, headline: after.verdictHeadline },
  };
}

export async function applyEdits(root: string, edits: readonly FileEdit[]): Promise<void> {
  for (const edit of edits) {
    const target = resolveProjectFile(root, edit.path);
    const current = await readFile(target, "utf8").catch(() => "");
    if (edit.before !== "" && current !== edit.before) {
      throw new Error(`Refusing to write ${edit.path} because its contents changed since the plan was built.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.launchymind-tmp`;
    await writeFile(temporary, edit.after, "utf8");
    await rename(temporary, target);
  }
}

interface Plan {
  fixId: string | null;
  available: boolean;
  warning: string | null;
  summary: string;
  draft: string;
  diff: string;
  edits: FileEdit[];
}

async function planFix(projectPath: string, report: LaunchReport, ruleId: string): Promise<Plan> {
  const finding = report.findings.find((item) => item.ruleId === ruleId);
  if (!finding || (finding.status !== "fail" && finding.status !== "unchecked")) {
    return emptyPlan(ruleId, "That rule is not an open finding, so there is nothing to write.");
  }
  if (PROPOSE_ONLY.has(ruleId)) {
    return {
      ...emptyPlan(ruleId, "This finding needs a human to write the text. The draft below is not applied."),
      available: true,
      warning: LAWYER_WARNING,
      draft: textDraft(ruleId),
    };
  }
  const edits = await editsFor(projectPath, report, ruleId);
  if (edits.length === 0) {
    return emptyPlan(ruleId, "No deterministic edit is available for this finding. Nothing was written.");
  }
  return {
    fixId: `${ruleId}/deterministic`,
    available: true,
    warning: null,
    summary: "Deterministic edit. Review the diff before approving it.",
    draft: edits.map((edit) => edit.path).join("\n"),
    diff: edits.map((edit) => unifiedDiff(edit.path, edit.before, edit.after)).join("\n"),
    edits,
  };
}

function emptyPlan(ruleId: string, summary: string): Plan {
  return { fixId: null, available: false, warning: null, summary, draft: textDraft(ruleId), diff: "", edits: [] };
}

async function editsFor(projectPath: string, report: LaunchReport, ruleId: string): Promise<FileEdit[]> {
  if (ruleId === "apple.privacy-manifest-tracking") return privacyManifestEdits(projectPath, report);
  if (ruleId === "google.ad-id-permission") return adIdEdits(projectPath);
  const usage = USAGE_KEYS[ruleId];
  if (usage) return usageEdits(projectPath, usage.key, usage.sentence);
  return [];
}

async function privacyManifestEdits(projectPath: string, report: LaunchReport): Promise<FileEdit[]> {
  const path = "ios/Runner/PrivacyInfo.xcprivacy";
  const absolute = resolve(projectPath, path);
  const before = await readFile(absolute, "utf8").catch(() => "");
  if (!before) return [];
  let after = before.replace(/(<key>\s*NSPrivacyTracking\s*<\/key>\s*)<false\s*\/>/, "$1<true/>");
  if (adsOrTracking(report.facts)) after = ensureCollectedTypes(after);
  if (after === before) return [];
  return [{ path, before, after }];
}

function ensureCollectedTypes(xml: string): string {
  let next = xml;
  for (const type of COLLECTED_TYPES) {
    if (next.includes(`<string>${type}</string>`)) continue;
    const dict = [
      "    <dict>",
      "      <key>NSPrivacyCollectedDataType</key>",
      `      <string>${type}</string>`,
      "      <key>NSPrivacyCollectedDataTypeLinked</key>",
      "      <false/>",
      "      <key>NSPrivacyCollectedDataTypeTracking</key>",
      "      <true/>",
      "      <key>NSPrivacyCollectedDataTypePurposes</key>",
      "      <array>",
      "        <string>NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising</string>",
      "      </array>",
      "    </dict>",
    ].join("\n");
    if (/<key>\s*NSPrivacyCollectedDataTypes\s*<\/key>\s*<array>/.test(next)) {
      next = next.replace(/(<key>\s*NSPrivacyCollectedDataTypes\s*<\/key>\s*<array>)/, `$1\n${dict}`);
    } else {
      next = next.replace(/<\/dict>\s*<\/plist>\s*$/, `  <key>NSPrivacyCollectedDataTypes</key>\n  <array>\n${dict}\n  </array>\n</dict>\n</plist>\n`);
    }
  }
  return next;
}

async function usageEdits(projectPath: string, key: string, sentence: string): Promise<FileEdit[]> {
  const path = "ios/Runner/Info.plist";
  const before = await readFile(resolve(projectPath, path), "utf8").catch(() => "");
  if (!before || new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>[^<]+</string>`).test(before)) return [];
  const insertion = `  <key>${key}</key>\n  <string>${escapeXml(sentence)}</string>\n`;
  if (!before.includes("</dict>")) return [];
  const after = before.replace("</dict>", `${insertion}</dict>`);
  return after === before ? [] : [{ path, before, after }];
}

async function adIdEdits(projectPath: string): Promise<FileEdit[]> {
  const path = "android/app/src/main/AndroidManifest.xml";
  const before = await readFile(resolve(projectPath, path), "utf8").catch(() => "");
  if (!before.includes("<manifest")) return [];
  const permission = '<uses-permission android:name="com.google.android.gms.permission.AD_ID"/>';
  let after = before.replace(/<uses-permission\b[^>]*com\.google\.android\.gms\.permission\.AD_ID[^>]*\/>/g, permission);
  if (!after.includes("com.google.android.gms.permission.AD_ID")) {
    after = after.replace(/<manifest\b[^>]*>/, (open) => `${open}\n    ${permission}`);
  }
  return after === before ? [] : [{ path, before, after }];
}

function adsOrTracking(facts: Record<string, FactValue>): boolean {
  return facts["capability.ads"] === true || facts["capability.tracking"] === true || facts["tracking.att_required"] === "yes";
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function textDraft(ruleId: string): string {
  if (ruleId.includes("privacy") || ruleId.startsWith("kvkk.")) return `${LAWYER_WARNING}\n\nWrite the policy yourself. LaunchyMind will not invent the legal text.`;
  if (ruleId.includes("account-deletion")) return "Add an in-app deletion path and a web page. LaunchyMind will not write that screen.";
  if (ruleId === "iab.app-ads") return "Publish app-ads.txt with seller ids from your ad networks. LaunchyMind will not invent seller ids.";
  return "";
}

export function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const newLines = after.replace(/\n$/, "").split("\n");
  const body = [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return `${body.join("\n")}\n`;
}

function gitDirty(root: string): boolean | "not-a-repo" {
  const inside = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return "not-a-repo";
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  if (status.status !== 0) return "not-a-repo";
  return status.stdout.trim().length > 0;
}
