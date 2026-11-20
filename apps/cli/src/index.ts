#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exitCodeForVerdict, LAUNCHYMIND_VERSION, NotFlutterProjectError, parseFailOn } from "../../../packages/core/src/index.ts";
import { blocksReady } from "../../../packages/verdict/src/index.ts";
import { applyApprovedFix, applyApprovedFixes } from "../../../packages/fixes/src/index.ts";
import { proposeFix } from "../../../packages/fixes/src/index.ts";
import { initProject } from "../../../packages/init/src/index.ts";
import { labelsForReport, renderLabels } from "../../../packages/labels/src/index.ts";
import { runMcpServer } from "../../../packages/mcp/src/index.ts";
import { runArtifactOnly, runScan } from "../../../packages/pipeline/src/index.ts";
import { readConnect, readConnectConfig } from "../../../packages/connect/src/index.ts";
import { findCorePackDir } from "../../../packages/core/src/index.ts";
import { addPack, listInstalledPacks, removePack } from "../../../packages/packs/src/index.ts";
import { loadPack, validatePack } from "../../../packages/rules/src/index.ts";
import { renderHtml, renderJson, renderTerminal } from "../../../packages/report/src/index.ts";
import { historyEnabled, readFixes, readHistory, recordFixIfEnabled, renderDashboard, renderHistory } from "../../../packages/history/src/index.ts";
import { checkSources, defaultBaselinePath, listRuleSources, needsReverify, readBaseline, renderSourceReport, withNewHashes, writeBaseline, writeProjectSourceStatus } from "../../../packages/sources/src/index.ts";

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string>;
  repeated: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    const stored = next && !next.startsWith("--") ? next : "true";
    if (stored !== "true") index += 1;
    options.set(key, stored);
    const list = repeated.get(key) ?? [];
    list.push(stored);
    repeated.set(key, list);
  }
  return { positionals, options, repeated };
}

function help(): string {
  return [
    `LaunchyMind by callabens  ${LAUNCHYMIND_VERSION}`,
    "",
    "Commands:",
    "  scan <path> [--artifact <ipa|apk|aab>] [--json] [--html <file>] [--output <file>] [--offline] [--lang en|tr] [--pack <dir>] [--fail-on reject|risky|none]",
    "  scan --artifact <ipa|apk|aab> [--offline]",
    "  connect [--project <path>]",
    "  labels <path> [--json] [--lang en|tr] [--offline]",
    "  sources check [--json] [--offline] [--record] [--record-status] [--project <path>]",
    "  history <path>",
    "  dashboard <path> [--out <file>]",
    "  explain <path> --why-not-ready [--offline] [--json]",
    "  init <path> [--set key=value]...     ask store-console questions; blank stays unchecked",
    "  rules",
    "  pack validate [directory]",
    "  pack add <path-or-git-url> [--project <path>]",
    "  pack list [--project <path>]",
    "  pack remove <id> [--project <path>]",
    "  fix <path> --rule <id> [--yes] [--dry-run] [--allow-dirty] [--offline]",
    "  fix <path> --all [--yes] [--dry-run] [--allow-dirty] [--offline]",
    "  fix propose <rule-id> [--project <path>] [--offline]",
    "  mcp",
    "",
    "Exit codes: 0 scan finished and is under the --fail-on line (default reject, so risky is 0),",
    "  2 risky when --fail-on risky, 3 reject, 4 not a Flutter, React Native, or Expo project, 1 other usage or runtime error.",
    "The verdict comes from the rule engine. This tool does not claim store approval or legal compliance.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, sub, extra] = args.positionals;
  if (!command || command === "help" || args.options.has("help")) {
    console.log(help());
    return;
  }

  if (command === "mcp") {
    await runMcpServer(process.cwd(), process.env.LAUNCHYMIND_ALLOW_APPLY === "1");
    return;
  }

  if (command === "rules") {
    const pack = await loadPack(findCorePackDir());
    for (const rule of pack.rules) {
      const state = rule.verification.status === "verified" ? rule.verification.verifiedAt ?? "verified" : "needs-manual-verification";
      console.log(`${rule.enabled ? "enabled " : "disabled"}  ${rule.severity.padEnd(8)}  ${rule.id}  ${state}`);
    }
    if (pack.withheld.length) {
      console.log("");
      console.log("Withheld until someone verifies the source by hand:");
      for (const rule of pack.withheld) console.log(`  ${rule.id}  ${rule.verification.status}`);
    }
    return;
  }

  if (command === "init") {
    if (!sub) throw new Error("Usage: launchymind init <path> [--set key=value]");
    const sets = (args.repeated.get("set") ?? []).filter((item) => item !== "true");
    const result = await initProject(resolve(sub), { sets, interactive: sets.length === 0 && !args.options.has("yes") });
    if (!result.wrote) {
      console.log("No answers were set. Blank store questions stay unchecked.");
      return;
    }
    console.log(`Updated ${result.path}`);
    if (result.set.length) console.log(`Set: ${result.set.join(", ")}`);
    return;
  }

  if (command === "pack" && sub === "validate") {
    const directory = resolve(extra ?? findCorePackDir());
    const pack = await loadPack(directory);
    const problems = validatePack(pack);
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log(`Valid data pack ${pack.meta.id} ${pack.meta.version}. ${pack.rules.length} enabled rules, ${pack.withheld.length} withheld.`);
    return;
  }

  if (command === "pack" && (sub === "add" || sub === "list" || sub === "remove")) {
    const project = resolve(args.options.get("project") ?? ".");
    if (sub === "list") {
      const packs = await listInstalledPacks(project);
      if (packs.length === 0) console.log("No project packs installed.");
      for (const pack of packs) console.log(`${pack.id}  ${pack.version}  ${pack.name}`);
      return;
    }
    if (sub === "add") {
      if (!extra) throw new Error("Usage: launchymind pack add <path-or-git-url> [--project <path>]");
      const installed = await addPack(project, extra);
      console.log(`Installed ${installed.id} ${installed.version} into ${installed.directory}`);
      return;
    }
    if (!extra) throw new Error("Usage: launchymind pack remove <id> [--project <path>]");
    await removePack(project, extra);
    console.log(`Removed ${extra}`);
    return;
  }

  if (command === "fix" && sub === "propose") {
    if (!extra) throw new Error("Usage: launchymind fix propose <rule-id> [--project <path>]");
    const project = resolve(args.options.get("project") ?? ".");
    const report = await runScan(project, { offline: args.options.has("offline") });
    console.log(JSON.stringify(await proposeFix(report, extra), null, 2));
    return;
  }

  if (command === "fix" && sub === "apply") {
    throw new Error("Use: launchymind fix <path> --rule <id> --yes");
  }

  if (command === "fix" && sub && sub !== "propose") {
    const rule = args.options.get("rule");
    const all = args.options.has("all");
    const dryRun = args.options.has("dry-run");
    const yes = args.options.has("yes");
    if (all && rule && rule !== "true") throw new Error("Use either --rule or --all, not both.");
    if (all) {
      const result = await applyApprovedFixes({
        projectPath: resolve(sub),
        approveAll: yes,
        dryRun,
        allowDirty: args.options.has("allow-dirty"),
        offline: args.options.has("offline"),
        confirm: !yes && !dryRun,
      });
      for (const item of result.results) {
        if (!item.diff) continue;
        console.log(`# ${item.ruleId}`);
        console.log(item.diff.trimEnd());
      }
      if (result.status === "BLOCKED" || result.status === "REFUSED") {
        console.error(result.reason);
        process.exitCode = 1;
        return;
      }
      console.log(result.reason);
      if (yes && !dryRun) {
        const appliedAt = new Date().toISOString();
        for (const item of result.results) {
          if (item.status === "APPLIED") await recordFixIfEnabled(resolve(sub), item.ruleId, appliedAt);
        }
      }
      if (result.before && result.after) {
        console.log(`Before: ${result.before.headline} (${result.before.verdict})`);
        console.log(`After: ${result.after.headline} (${result.after.verdict})`);
      }
      return;
    }
    if (!rule || rule === "true") throw new Error("Usage: launchymind fix <path> --rule <id> [--yes] [--dry-run] [--allow-dirty] [--offline]");
    const result = await applyApprovedFix({
      projectPath: resolve(sub),
      ruleId: rule,
      approved: yes,
      dryRun,
      allowDirty: args.options.has("allow-dirty"),
      offline: args.options.has("offline"),
      confirm: !yes && !dryRun,
    });
    if (result.diff) console.log(result.diff.trimEnd());
    if (result.status === "BLOCKED" || result.status === "REFUSED") {
      console.error(result.reason);
      process.exitCode = 1;
      return;
    }
    console.log(result.reason);
    if (yes && !dryRun && result.status === "APPLIED") await recordFixIfEnabled(resolve(sub), rule, new Date().toISOString());
    if (result.before && result.after) {
      console.log(`Before: ${result.before.headline} (${result.before.verdict})`);
      console.log(`After: ${result.after.headline} (${result.after.verdict})`);
    }
    return;
  }

  if (command === "sources" && sub === "check") {
    if (args.options.has("offline")) {
      console.log("Source check was not run. Pass it without --offline to fetch the cited pages.");
      return;
    }
    const project = resolve(args.options.get("project") ?? ".");
    const baselinePath = defaultBaselinePath();
    const baseline = await readBaseline(baselinePath);
    const report = await checkSources({ sources: await listRuleSources(), baseline, fetchImpl: fetch, now: new Date() });
    if (args.options.has("record")) await writeBaseline(baselinePath, withNewHashes(baseline, report, report.checkedAt.slice(0, 10)));
    if (args.options.has("record-status")) await writeProjectSourceStatus(project, needsReverify(report), report.checkedAt);
    if (args.options.has("json")) console.log(JSON.stringify({ ...report, results: report.results.map(({ samples: _samples, ...item }) => item) }, null, 2));
    else console.log(renderSourceReport(report));
    if (report.changed > 0 || report.broken > 0) process.exitCode = 2;
    return;
  }

  if (command === "history") {
    if (!sub) throw new Error("Usage: launchymind history <path>");
    const project = resolve(sub);
    if (!(await historyEnabled(project))) {
      console.log("History is off. Set history: true in .launchymind/project.yaml. Nothing was written.");
      return;
    }
    console.log(renderHistory(await readHistory(project)));
    return;
  }

  if (command === "dashboard") {
    if (!sub) throw new Error("Usage: launchymind dashboard <path> [--out <file>]");
    const project = resolve(sub);
    const out = args.options.get("out");
    const target = out && out !== "true" ? resolve(out) : join(project, ".launchymind", "dashboard.html");
    const html = renderDashboard(await readHistory(project), await readFixes(project));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html, "utf8");
    console.log(target);
    return;
  }

  if (command === "labels") {
    if (!sub) throw new Error("Usage: launchymind labels <path> [--json] [--lang en|tr] [--offline]");
    const lang = args.options.get("lang") === "tr" ? "tr" : "en";
    const report = await runScan(resolve(sub), { offline: args.options.has("offline") });
    const draft = await labelsForReport(report);
    if (args.options.has("json")) console.log(JSON.stringify(draft, null, 2));
    else console.log(renderLabels(draft, lang));
    return;
  }

  if (command === "connect") {
    const report = await readConnect(readConnectConfig(process.env), fetch, args.options.has("offline"));
    for (const line of report.lines) console.log(line);
    return;
  }

  if (command === "explain") {
    if (!sub || !args.options.has("why-not-ready")) throw new Error("Usage: launchymind explain <path> --why-not-ready [--offline] [--json]");
    const report = await runScan(resolve(sub), { offline: args.options.has("offline") });
    const blockers = blocksReady(report.findings, report.limitations);
    if (args.options.has("json")) {
      console.log(JSON.stringify({ verdict: report.verdict, headline: report.verdictHeadline, blocksReady: blockers }, null, 2));
      return;
    }
    console.log(`${report.verdictHeadline} (${report.verdict})`);
    if (blockers.length === 0) {
      console.log("Nothing blocks READY.");
      return;
    }
    console.log("These items block READY:");
    for (const item of blockers) {
      const id = item.ruleId ? `${item.ruleId} — ` : "";
      console.log(`- [${item.kind}] ${item.severity ?? "limit"} ${id}${item.title}`);
      console.log(`  ${item.detail}`);
    }
    return;
  }

  if (command === "scan") {
    const artifact = args.options.get("artifact");
    const artifactPath = artifact && artifact !== "true" ? resolve(artifact) : undefined;
    if (!sub && artifactPath) {
      const report = await runArtifactOnly(artifactPath, { offline: args.options.has("offline") });
      console.log(renderTerminal(report, "en"));
      process.exitCode = exitCodeForVerdict(report.verdict, parseFailOn(args.options.get("fail-on")));
      return;
    }
    if (!sub) throw new Error("Usage: launchymind scan <path>");
    const lang = args.options.get("lang") === "tr" ? "tr" : "en";
    if (args.options.has("lang") && lang === "en" && args.options.get("lang") !== "en") {
      throw new Error("Supported languages: en, tr.");
    }
    const pack = args.options.get("pack");
    const report = await runScan(resolve(sub), {
      offline: args.options.has("offline"),
      ...(pack && pack !== "true" ? { packDir: resolve(pack) } : {}),
      ...(artifactPath ? { artifactPath } : {}),
    });
    const html = args.options.get("html");
    const output = args.options.get("output");
    if (html && html !== "true") {
      await mkdir(dirname(resolve(html)), { recursive: true });
      await writeFile(resolve(html), renderHtml(report), "utf8");
    }
    const wroteJson = Boolean(output && output !== "true");
    if (wroteJson && output) {
      await mkdir(dirname(resolve(output)), { recursive: true });
      await writeFile(resolve(output), `${renderJson(report)}\n`, "utf8");
    }
    if (args.options.has("json") && !wroteJson) console.log(renderJson(report));
    else console.log(renderTerminal(report, lang));
    process.exitCode = exitCodeForVerdict(report.verdict, parseFailOn(args.options.get("fail-on")));
    return;
  }

  throw new Error(`Unknown command.\n\n${help()}`);
}

main().catch((error: unknown) => {
  if (error instanceof NotFlutterProjectError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  console.error(`LaunchyMind error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
