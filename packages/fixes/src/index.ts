import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface BatchApplyResult {
  status: "APPLIED" | "DRY_RUN" | "BLOCKED" | "REFUSED" | "PARTIAL";
  writesFiles: boolean;
  reason: string;
  results: ApplyResult[];
  before: { verdict: Verdict; headline: string } | null;
  after: { verdict: Verdict; headline: string } | null;
}

export async function listWritableFixes(report: LaunchReport): Promise<FixProposal[]> {
  const open = report.findings.filter((finding) => finding.status === "fail" || finding.status === "unchecked");
  const proposals: FixProposal[] = [];
  for (const finding of open) {
    const proposal = await proposeFix(report, finding.ruleId);
    if (proposal.canApply && proposal.fixId) proposals.push(proposal);
  }
  return proposals.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

export async function applyApprovedFixes(options: {
  projectPath: string;
  approvals?: ReadonlyArray<{ ruleId: string; fixId: string | null; approved: boolean }>;
  approveAll?: boolean;
  dryRun: boolean;
  allowDirty: boolean;
  offline?: boolean;
  confirm?: boolean;
  requireOperator?: boolean;
  operatorEnabled?: boolean;
  requireFixId?: boolean;
}): Promise<BatchApplyResult> {
  const projectPath = resolve(options.projectPath);
  const before = await runScan(projectPath, { offline: options.offline === true });
  const proposals = await listWritableFixes(before);
  const snapshot = { verdict: before.verdict, headline: before.verdictHeadline };
  const results: ApplyResult[] = proposals.map((proposal) => ({
    status: "BLOCKED",
    writesFiles: false,
    reason: "Not approved.",
    ruleId: proposal.ruleId,
    fixId: proposal.fixId,
    diff: proposal.diff,
    before: snapshot,
    after: null,
  }));
  if (options.requireOperator && options.operatorEnabled !== true) {
    return { status: "BLOCKED", writesFiles: false, reason: "apply_fix is off. Start the MCP server with LAUNCHYMIND_ALLOW_APPLY=1. No file was changed.", results, before: snapshot, after: null };
  }
  if (proposals.length === 0) {
    return { status: "REFUSED", writesFiles: false, reason: "No writable fix is open. No file was changed.", results, before: snapshot, after: null };
  }
  if (options.dryRun) {
    return {
      status: "DRY_RUN",
      writesFiles: false,
      reason: "Dry run. The diffs are above and no file was changed.",
      results: results.map((result) => ({ ...result, status: "DRY_RUN", reason: "Dry run. No file was changed." })),
      before: snapshot,
      after: null,
    };
  }
  const chosen = new Set<string>();
  if (options.approveAll) {
    for (const proposal of proposals) if (proposal.fixId) chosen.add(proposal.fixId);
  } else if (options.confirm) {
    if (!stdin.isTTY) {
      return { status: "BLOCKED", writesFiles: false, reason: "Refusing to write without --yes when there is no interactive terminal. No file was changed.", results, before: snapshot, after: null };
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (const proposal of proposals) {
        stdout.write(`\n${proposal.ruleId}\n${proposal.diff}`);
        const answer = (await rl.question(`Apply ${proposal.ruleId}? [y/N] `)).trim().toLowerCase();
        if ((answer === "y" || answer === "yes") && proposal.fixId) chosen.add(proposal.fixId);
      }
    } finally {
      rl.close();
    }
  } else {
    for (const approval of options.approvals ?? []) {
      const proposal = proposals.find((item) => item.ruleId === approval.ruleId);
      const index = results.findIndex((item) => item.ruleId === approval.ruleId);
      if (!proposal?.fixId) continue;
      const mismatch = (options.requireFixId && approval.fixId !== proposal.fixId) || (approval.fixId != null && approval.fixId !== proposal.fixId);
      if (mismatch) {
        if (index >= 0) results[index] = { ...results[index]!, status: "REFUSED", reason: "The fix id does not match the plan from propose_fix. No file was changed." };
        continue;
      }
      if (approval.approved) chosen.add(proposal.fixId);
    }
  }
  if (chosen.size === 0) {
    const refused = results.some((item) => item.status === "REFUSED");
    return {
      status: refused ? "REFUSED" : "BLOCKED",
      writesFiles: false,
      reason: refused ? "The fix id does not match the plan from propose_fix. No file was changed." : "No fix was approved. No file was changed.",
      results,
      before: snapshot,
      after: null,
    };
  }
  const dirty = gitDirty(projectPath);
  if (dirty === true && !options.allowDirty) {
    return { status: "REFUSED", writesFiles: false, reason: "The git tree has uncommitted changes. Re-run with --allow-dirty to write anyway. No file was changed.", results, before: snapshot, after: null };
  }
  let wrote = 0;
  for (const proposal of proposals) {
    const index = results.findIndex((item) => item.ruleId === proposal.ruleId);
    if (!proposal.fixId || !chosen.has(proposal.fixId)) continue;
    const plan = await planFix(projectPath, await runScan(projectPath, { offline: options.offline === true }), proposal.ruleId);
    if (plan.fixId !== proposal.fixId || plan.edits.length === 0) {
      if (index >= 0) results[index] = { ...results[index]!, status: "REFUSED", writesFiles: false, reason: "The fix no longer matches the file. It was not written.", diff: plan.diff, fixId: plan.fixId };
      continue;
    }
    await applyEdits(projectPath, plan.edits);
    wrote += 1;
    if (index >= 0) results[index] = { ...results[index]!, status: "APPLIED", writesFiles: true, reason: `Wrote ${plan.edits.length} file(s).`, diff: plan.diff };
  }
  const after = await runScan(projectPath, { offline: options.offline === true });
  const afterSnapshot = { verdict: after.verdict, headline: after.verdictHeadline };
  for (const result of results) result.after = afterSnapshot;
  const skipped = proposals.length - wrote;
  return {
    status: skipped > 0 ? "PARTIAL" : "APPLIED",
    writesFiles: wrote > 0,
    reason: `Wrote ${wrote} fix(es).${skipped > 0 ? ` Skipped ${skipped}.` : ""} Verdict ${before.verdictHeadline} -> ${after.verdictHeadline}.`,
    results,
    before: snapshot,
    after: afterSnapshot,
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
  if (!adsOrTracking(report.facts) && report.facts["ios.privacy_manifest.tracking"] !== "false") return [];
  const path = await findProjectRelative(projectPath, "ios/Runner/PrivacyInfo.xcprivacy", "PrivacyInfo.xcprivacy", "ios");
  if (!path) return [];
  const before = await readFile(resolve(projectPath, path), "utf8").catch(() => "");
  if (!before) return [];
  const after = before.replace(/(<key>\s*NSPrivacyTracking\s*<\/key>\s*)<false\s*\/>/, "$1<true/>");
  if (after === before) return [];
  return [{ path, before, after }];
}

async function usageEdits(projectPath: string, key: string, sentence: string): Promise<FileEdit[]> {
  const path = await findProjectRelative(projectPath, "ios/Runner/Info.plist", "Info.plist", "ios");
  if (!path) return [];
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

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const oldLines = splitKeep(before);
  const newLines = splitKeep(after);
  const ops = diffLines(oldLines, newLines);
  const hunks = hunksFrom(ops, context);
  if (hunks.length === 0) return "";
  const body = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    body.push(...hunk.lines);
  }
  return `${body.join("\n")}\n`;
}

function splitKeep(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function diffLines(before: string[], after: string[]): Array<{ op: " " | "-" | "+"; line: string }> {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i];
    const next = dp[i + 1];
    if (!row || !next) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: Array<{ op: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const row = dp[i];
    const down = dp[i + 1];
    if (before[i] === after[j]) {
      ops.push({ op: " ", line: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((down?.[j] ?? 0) >= (row?.[j + 1] ?? 0)) {
      ops.push({ op: "-", line: before[i] ?? "" });
      i += 1;
    } else {
      ops.push({ op: "+", line: after[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: "-", line: before[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: "+", line: after[j] ?? "" });
    j += 1;
  }
  return ops;
}

function hunksFrom(ops: Array<{ op: " " | "-" | "+"; line: string }>, context: number): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> {
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.op !== " ") changed.push(index);
  });
  if (changed.length === 0) return [];
  const groups: number[][] = [];
  for (const index of changed) {
    const current = groups[groups.length - 1];
    if (!current || index - (current[current.length - 1] ?? index) > context * 2) groups.push([index]);
    else current.push(index);
  }
  return groups.map((group) => {
    const start = Math.max(0, (group[0] ?? 0) - context);
    const end = Math.min(ops.length, (group[group.length - 1] ?? 0) + context + 1);
    const slice = ops.slice(start, end);
    let oldStart = 1;
    let newStart = 1;
    for (let index = 0; index < start; index += 1) {
      const op = ops[index];
      if (!op || op.op === "+") continue;
      oldStart += 1;
    }
    for (let index = 0; index < start; index += 1) {
      const op = ops[index];
      if (!op || op.op === "-") continue;
      newStart += 1;
    }
    const oldCount = slice.filter((op) => op.op !== "+").length;
    const newCount = slice.filter((op) => op.op !== "-").length;
    return {
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: slice.map((op) => `${op.op}${op.line}`),
    };
  });
}

async function findProjectRelative(root: string, preferred: string, fileName: string, under: string): Promise<string | null> {
  const preferredAbs = resolve(root, preferred);
  if (await readFile(preferredAbs, "utf8").then((text) => text.length >= 0).catch(() => false)) return preferred;
  const found = await walkFor(resolve(root, under), fileName, new Set(["Pods", ".symlinks", "build", "node_modules"]));
  if (!found) return null;
  return relative(resolve(root), found).split(sep).join("/");
}

async function walkFor(dir: string, fileName: string, skipped: Set<string>): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skipped.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFor(full, fileName, skipped);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) return full;
  }
  return null;
}

function gitDirty(root: string): boolean | "not-a-repo" {
  const inside = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return "not-a-repo";
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  if (status.status !== 0) return "not-a-repo";
  return status.stdout.trim().length > 0;
}
