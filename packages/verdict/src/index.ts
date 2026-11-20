import type { Finding, Limitation, Severity, Verdict } from "../../core/src/index.ts";

export interface VerdictDecision {
  verdict: Verdict;
  headline: string;
  because: string[];
}

export interface ReadyBlocker {
  kind: "fail" | "unchecked" | "limitation";
  ruleId: string | null;
  severity: Severity | null;
  title: string;
  detail: string;
}

/** Findings and limits that keep decideVerdict from returning ready. Info failures are not in that set. */
export function blocksReady(findings: readonly Finding[], limitations: readonly Limitation[] = []): ReadyBlocker[] {
  const applicable = findings.filter((finding) => finding.status !== "not_applicable");
  const blockers: ReadyBlocker[] = [];
  for (const finding of applicable) {
    if (finding.status === "fail" && finding.severity === "info") continue;
    if (finding.status !== "fail" && finding.status !== "unchecked") continue;
    blockers.push({
      kind: finding.status,
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: finding.title,
      detail: finding.summaryEn,
    });
  }
  for (const limit of limitations) {
    if (!limit.blocksReady) continue;
    blockers.push({
      kind: "limitation",
      ruleId: null,
      severity: null,
      title: limit.id,
      detail: limit.detail,
    });
  }
  return blockers;
}

/**
 * The only function that names a verdict.
 * Findings come from the rule engine. Nothing in this module accepts an override.
 */
export function decideVerdict(findings: readonly Finding[], limitations: readonly Limitation[] = []): VerdictDecision {
  const applicable = findings.filter((finding) => finding.status !== "not_applicable");
  const blockerFails = applicable.filter((finding) => finding.status === "fail" && finding.severity === "blocker");
  const riskFails = applicable.filter((finding) => finding.status === "fail" && finding.severity === "risk");
  const unchecked = applicable.filter((finding) => finding.status === "unchecked");
  const blockingLimits = limitations.filter((item) => item.blocksReady);

  if (blockerFails.length > 0) {
    return {
      verdict: "reject",
      headline: headlineFor("reject", blockerFails),
      because: blockerFails.map((finding) => sentence(finding, "fail")),
    };
  }

  const because = [
    ...riskFails.map((finding) => sentence(finding, "fail")),
    ...unchecked.map((finding) => sentence(finding, "unchecked")),
    ...blockingLimits.map((item) => item.detail),
  ];

  if (because.length > 0 || applicable.length === 0) {
    if (applicable.length === 0 && because.length === 0) {
      because.push("No applicable rule was checked, so this cannot be called ready.");
    }
    return { verdict: "risky", headline: "RISKY", because };
  }

  return {
    verdict: "ready",
    headline: "READY",
    because: ["Every applicable rule passed. This is still not store approval."],
  };
}

function sentence(finding: Finding, kind: "fail" | "unchecked"): string {
  const body = kind === "fail"
    ? finding.summaryEn
    : `Could not check this from the project. ${finding.summaryEn}`;
  const next = finding.nextEn ? ` Next: ${finding.nextEn}` : "";
  return `${body}${next}`;
}

function headlineFor(verdict: Verdict, blockers: readonly Finding[]): string {
  if (verdict !== "reject") return verdict === "ready" ? "READY" : "RISKY";
  if (blockers.length === 1 && blockers[0]?.ruleId === "apple.privacy-policy-in-app") return "NOT READY";
  return "LIKELY TO BE REJECTED";
}
