import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { LAUNCHYMIND_VERSION } from "../../core/src/index.ts";
import { applyFix, proposeFix } from "../../fixes/src/index.ts";
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
      "Do not write project files. apply_fix is off unless the operator enabled it, and this preview still does not write.",
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
    description: "Scan a project and return findings with file or URL evidence. Does not run the app and does not set the verdict.",
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

  server.registerTool("launchymind_propose_fix", {
    description: "Prepare a fix draft and describe the change. Does not write files.",
    inputSchema: { projectPath, offline, ruleId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => text(proposeFix(await scan(defaultRoot, input.projectPath, input.offline), input.ruleId)));

  server.registerTool("launchymind_apply_fix", {
    description: "Apply an approved draft. Off by default. This preview does not write files even when enabled.",
    inputSchema: {
      projectPath,
      ruleId,
      approved: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const result = applyFix(input.approved === true, allowApply);
    return { ...text(result), isError: true };
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
