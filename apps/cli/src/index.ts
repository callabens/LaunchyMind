#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exitCodeForVerdict, LAUNCHYMIND_VERSION, NotFlutterProjectError, parseFailOn } from "../../../packages/core/src/index.ts";
import { applyApprovedFix, proposeFix } from "../../../packages/fixes/src/index.ts";
import { runMcpServer } from "../../../packages/mcp/src/index.ts";
import { runScan } from "../../../packages/pipeline/src/index.ts";
import { findCorePackDir } from "../../../packages/core/src/index.ts";
import { loadPack, validatePack } from "../../../packages/rules/src/index.ts";
import { renderHtml, renderJson, renderTerminal } from "../../../packages/report/src/index.ts";

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else options.set(key, "true");
  }
  return { positionals, options };
}

function help(): string {
  return [
    `LaunchyMind by callabens  ${LAUNCHYMIND_VERSION}`,
    "",
    "Commands:",
    "  scan <path> [--json] [--html <file>] [--output <file>] [--offline] [--lang en|tr] [--pack <dir>] [--fail-on reject|risky|none]",
    "  rules",
    "  pack validate [directory]",
    "  fix <path> --rule <id> [--yes] [--dry-run] [--allow-dirty] [--offline]",
    "  fix propose <rule-id> [--project <path>] [--offline]",
    "  mcp",
    "",
    "Exit codes: 0 scan finished and is under the --fail-on line (default reject, so risky is 0),",
    "  2 risky when --fail-on risky, 3 reject, 4 not a Flutter project, 1 other usage or runtime error.",
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
    if (!rule || rule === "true") throw new Error("Usage: launchymind fix <path> --rule <id> [--yes] [--dry-run] [--allow-dirty] [--offline]");
    const dryRun = args.options.has("dry-run");
    const yes = args.options.has("yes");
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
    if (result.before && result.after) {
      console.log(`Before: ${result.before.headline} (${result.before.verdict})`);
      console.log(`After: ${result.after.headline} (${result.after.verdict})`);
    }
    return;
  }

  if (command === "scan") {
    if (!sub) throw new Error("Usage: launchymind scan <path>");
    const lang = args.options.get("lang") === "tr" ? "tr" : "en";
    if (args.options.has("lang") && lang === "en" && args.options.get("lang") !== "en") {
      throw new Error("Supported languages: en, tr.");
    }
    const pack = args.options.get("pack");
    const report = await runScan(resolve(sub), {
      offline: args.options.has("offline"),
      ...(pack && pack !== "true" ? { packDir: resolve(pack) } : {}),
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
