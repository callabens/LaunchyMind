export interface ReportFinding {
  ruleId: string;
  title: string;
  status: string;
  severity: string;
  summaryEn: string;
  sourceUrl: string;
  evidence: Array<{ detail: string; path?: string; line?: number }>;
}

export interface DiagnosticDraft {
  ruleId: string;
  severity: "error" | "warning" | "information";
  message: string;
  sourceUrl: string;
  path: string | null;
  line: number | null;
}

export function diagnosticsFromFindings(findings: readonly ReportFinding[]): DiagnosticDraft[] {
  const drafts: DiagnosticDraft[] = [];
  for (const finding of findings) {
    if (finding.status !== "fail" && finding.status !== "unchecked") continue;
    const evidence = finding.evidence.find((item) => item.path) ?? finding.evidence[0];
    const severity = finding.status === "unchecked" ? "information" : finding.severity === "blocker" ? "error" : "warning";
    drafts.push({
      ruleId: finding.ruleId,
      severity,
      message: `${finding.title}. ${evidence?.detail ?? finding.summaryEn}`,
      sourceUrl: finding.sourceUrl,
      path: evidence?.path ?? null,
      line: typeof evidence?.line === "number" ? evidence.line : null,
    });
  }
  return drafts;
}
