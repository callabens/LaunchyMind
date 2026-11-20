import { LOCALES } from "../../i18n/src/index.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { LAUNCHYMIND_VERSION } from "../../core/src/index.ts";
import { applyApprovedFix, applyApprovedFixes, listWritableFixes, proposeFix } from "../../fixes/src/index.ts";
import { labelsForReport, renderLabels } from "../../labels/src/index.ts";
import { runScan } from "../../pipeline/src/index.ts";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const projectPath = z.string().trim().min(1).max(4096).optional();
const offline = z.boolean().optional();
const ruleId = z.string().regex(/^[a-z0-9]+(?:[.][a-z0-9-]+)+$/);

export function createLaunchyMindServer(defaultRoot: string, allowApply = false): McpServer {
  const server = new McpServer({
    name: "launchymind",
    version: LAUNCHYMIND_VERSION,
  }, {
    instructions: [
      "LaunchyMind checks mobile-app release readiness.",
      "The verdict comes only from the deterministic rule engine. There is no tool that sets the verdict.",
      "Do not say the app is legally compliant or that a store will approve it.",
      "Do not write project files unless the user approves. apply_fix writes only when the operator set LAUNCHYMIND_ALLOW_APPLY=1, approved is true, and fixId is the exact id returned by propose_fix. apply_fixes does the same for each item in fixes.",
      "After a code change, scan again before saying a finding is fixed.",
      "If a rule is unchecked, say it could not be checked.",
    ].join(" "),
  });

  server.registerTool("launchymind_get_overview", {
    description: "Read-only first call. Returns capabilities, the engine verdict, and open findings. Does not set the verdict.",
    inputSchema: { projectPath, offline },
    annotations: readOnly,
  }, async (input) => text(overview(await scan(defaultRoot, input.projectPath, input.offline))));

  server.registerTool("launchymind_scan", {
    description: "Scan a project and return findings with file or URL evidence, including store, RevenueCat paywall, SDK, Data safety declaration, and legal-pack rules. Does not run or build the app and does not set the verdict.",
    inputSchema: { projectPath, offline },
    annotations: readOnly,
  }, async (input) => text(await scan(defaultRoot, input.projectPath, input.offline)));

  server.registerTool("launchymind_explain_finding", {
    description: "Explain one finding with its rule, source link, verification date, and evidence. Does not change the verdict.",
    inputSchema: { projectPath, offline, ruleId },
    annotations: readOnly,
  }, async (input) => text(explain(await scan(defaultRoot, input.projectPath, input.offline), input.ruleId)));

  server.registerTool("launchymind_get_verdict", {
    description: "Return the engine verdict and the findings that caused it. This tool cannot set or override the verdict.",
    inputSchema: { projectPath, offline },
    annotations: readOnly,
  }, async (input) => {
    const report = await scan(defaultRoot, input.projectPath, input.offline);
    return text({
      verdict: report.verdict,
      because: report.verdictBecause,
      disclaimers: report.disclaimers,
      pack: report.pack,
    });
  });

  server.registerTool("launchymind_labels", {
    description: "Draft App Privacy and Play Data safety rows from verified SDK disclosure pages. The result is a draft, not a verdict and not legal advice. Unknown SDKs add no row.",
    inputSchema: { projectPath, offline, lang: z.enum(LOCALES).optional() },
    annotations: readOnly,
  }, async (input) => {
    const report = await scan(defaultRoot, input.projectPath, input.offline);
    const draft = await labelsForReport(report);
    return text({ ...draft, text: renderLabels(draft, input.lang ?? "en") });
  });

  server.registerTool("launchymind_propose_fix", {
    description: "Prepare a fix diff and a fixId. Does not write files. Deterministic edits can be applied later with that exact fixId.",
    inputSchema: { projectPath, offline, ruleId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => text(await proposeFix(await scan(defaultRoot, input.projectPath, input.offline), input.ruleId)));

  server.registerTool("launchymind_propose_fixes", {
    description: "List every writable fix with its diff and fixId. Does not write files.",
    inputSchema: { projectPath, offline },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => text(await listWritableFixes(await scan(defaultRoot, input.projectPath, input.offline))));

  server.registerTool("launchymind_apply_fixes", {
    description: "Write several deterministic fixes. Each item needs approved=true and the exact fixId from propose_fixes. Requires LAUNCHYMIND_ALLOW_APPLY=1. Refuses a dirty git tree unless allowDirty is true. dryRun writes nothing.",
    inputSchema: {
      projectPath,
      fixes: z.array(z.object({
        ruleId,
        fixId: z.string().min(1).nullable().optional(),
        approved: z.boolean().optional(),
      })).max(50),
      allowDirty: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const root = input.projectPath ? resolve(defaultRoot, input.projectPath) : defaultRoot;
    const result = await applyApprovedFixes({
      projectPath: root,
      approvals: (input.fixes ?? []).map((item) => ({
        ruleId: item.ruleId,
        fixId: item.fixId ?? null,
        approved: item.approved === true,
      })),
      dryRun: input.dryRun === true,
      allowDirty: input.allowDirty === true,
      offline: true,
      requireOperator: true,
      operatorEnabled: allowApply,
      requireFixId: true,
    });
    return { ...text(result), isError: result.status === "BLOCKED" || result.status === "REFUSED" };
  });

  server.registerTool("launchymind_apply_fix", {
    description: "Write a deterministic fix. Requires LAUNCHYMIND_ALLOW_APPLY=1, approved=true, and the exact fixId from propose_fix. Refuses a dirty git tree unless allowDirty is true. dryRun writes nothing.",
    inputSchema: {
      projectPath,
      ruleId,
      fixId: z.string().min(1).optional(),
      approved: z.boolean().optional(),
      allowDirty: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const root = input.projectPath ? resolve(defaultRoot, input.projectPath) : defaultRoot;
    const result = await applyApprovedFix({
      projectPath: root,
      ruleId: input.ruleId,
      fixId: input.fixId ?? null,
      approved: input.approved === true,
      dryRun: input.dryRun === true,
      allowDirty: input.allowDirty === true,
      offline: true,
      requireOperator: true,
      operatorEnabled: allowApply,
      requireFixId: true,
    });
    return { ...text(result), isError: result.status === "BLOCKED" || result.status === "REFUSED" };
  });

  return server;
}

async function scan(defaultRoot: string, requested: string | undefined, offline: boolean | undefined) {
  const root = requested ? resolve(defaultRoot, requested) : defaultRoot;
  return runScan(root, { offline: offline === true });
}

function overview(report: Awaited<ReturnType<typeof scan>>) {
  return {
    project: {
      name: report.profile.displayName ?? report.profile.name,
      framework: report.profile.framework,
      platforms: report.profile.platforms,
    },
    capabilities: report.profile.capabilities.filter((item) => item.present === true).map((item) => item.id),
    verdict: report.verdict,
    because: report.verdictBecause,
    disclaimers: report.disclaimers,
    openFindings: report.findings
      .filter((finding) => finding.status === "fail" || finding.status === "unchecked")
      .map((finding) => ({
        ruleId: finding.ruleId,
        status: finding.status,
        severity: finding.severity,
        summary: finding.summaryEn,
      })),
    pack: report.pack,
  };
}

function explain(report: Awaited<ReturnType<typeof scan>>, id: string) {
  const finding = report.findings.find((item) => item.ruleId === id);
  if (!finding) {
    const withheld = report.withheld.find((item) => item.ruleId === id);
    if (!withheld) return { found: false, ruleId: id, note: "No finding used that rule id." };
    return {
      found: true,
      withheld: true,
      ruleId: id,
      reason: withheld.reason,
      sourceUrl: withheld.sourceUrl,
      legalNotice: "This is not legal advice.",
    };
  }
  return {
    found: true,
    withheld: false,
    ruleId: finding.ruleId,
    status: finding.status,
    severity: finding.severity,
    confidence: finding.confidence,
    summaryEn: finding.summaryEn,
    summaryTr: finding.summaryTr,
    sourceUrl: finding.sourceUrl,
    sourceSection: finding.sourceSection,
    sourcePublisher: finding.sourcePublisher,
    verifiedAt: finding.verifiedAt,
    stale: finding.stale,
    checkNote: finding.checkNote,
    evidence: finding.evidence,
    legalNotice: finding.origin === "legal" ? "This is not legal advice. Ask a lawyer before you rely on it." : null,
    verdict: report.verdict,
    verdictNote: "The verdict was computed by the rule engine. This explanation does not change it.",
  };
}

export async function runMcpServer(root = process.cwd(), allowApply = process.env.LAUNCHYMIND_ALLOW_APPLY === "1"): Promise<void> {
  await createLaunchyMindServer(root, allowApply).connect(new StdioServerTransport());
}
