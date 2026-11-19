import type { Finding, Limitation, Verdict } from "../../core/src/index.ts";

export interface VerdictDecision {
  verdict: Verdict;
  because: string[];
}

/**
 * The only verdict function in LaunchyMind.
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
      because: blockerFails.map((finding) => `${finding.ruleId} failed and is a blocker.`),
    };
  }

  const because = [
    ...riskFails.map((finding) => `${finding.ruleId} failed and needs a human look.`),
    ...unchecked.map((finding) => `${finding.ruleId} could not be checked.`),
    ...blockingLimits.map((item) => `${item.id} blocks a ready verdict.`),
  ];

  if (because.length > 0 || applicable.length === 0) {
    if (applicable.length === 0 && because.length === 0) {
      because.push("No applicable rule was checked, so this cannot be called ready.");
    }
    return { verdict: "risky", because };
  }

  return {
    verdict: "ready",
    because: ["Every applicable rule passed. This is still not store approval."],
  };
}
