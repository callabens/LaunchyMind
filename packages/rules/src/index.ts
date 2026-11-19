import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  factsReferenced,
  isStale,
  matchCondition,
  packMetaSchema,
  ruleCaseSchema,
  ruleSchema,
  STALE_DAYS_DEFAULT,
  type Evidence,
  type FactValue,
  type Finding,
  type FindingStatus,
  type PackMeta,
  type Rule,
  type RuleCase,
  type WithheldRule,
} from "../../core/src/index.ts";

export interface LoadedPack {
  directory: string;
  meta: PackMeta;
  rules: Rule[];
  withheld: Rule[];
  cases: RuleCase[];
}

export interface Evaluation {
  findings: Finding[];
  withheld: WithheldRule[];
}

function asDocument(text: string, label: string): unknown {
  try {
    return parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid YAML: ${message}`);
  }
}

function parseRules(value: unknown, label: string): Rule[] {
  if (!value || typeof value !== "object" || !("rules" in value) || !Array.isArray(value.rules)) {
    throw new Error(`${label} must contain a rules list.`);
  }
  return value.rules.map((rule, index) => {
    const parsed = ruleSchema.safeParse(rule);
    if (!parsed.success) {
      throw new Error(`${label} rule ${index + 1} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return parsed.data;
  });
}

export async function loadPack(directory: string): Promise<LoadedPack> {
  const [metaText, rulesText, withheldText, casesText] = await Promise.all([
    readFile(join(directory, "pack.yaml"), "utf8"),
    readFile(join(directory, "rules.yaml"), "utf8"),
    readFile(join(directory, "withheld.yaml"), "utf8"),
    readFile(join(directory, "cases.yaml"), "utf8"),
  ]);
  const metaParsed = packMetaSchema.safeParse(asDocument(metaText, "pack.yaml"));
  if (!metaParsed.success) {
    throw new Error(`pack.yaml is invalid: ${metaParsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const rules = parseRules(asDocument(rulesText, "rules.yaml"), "rules.yaml");
  const withheld = parseRules(asDocument(withheldText, "withheld.yaml"), "withheld.yaml");
  const casesDocument = asDocument(casesText, "cases.yaml");
  if (!casesDocument || typeof casesDocument !== "object" || !("cases" in casesDocument) || !Array.isArray(casesDocument.cases)) {
    throw new Error("cases.yaml must contain a cases list.");
  }
  const cases = casesDocument.cases.map((item, index) => {
    const parsed = ruleCaseSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`cases.yaml case ${index + 1} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return parsed.data;
  });
  const loaded = { directory, meta: metaParsed.data, rules, withheld, cases };
  const problems = validatePack(loaded);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return loaded;
}

export function validatePack(pack: LoadedPack): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const rule of [...pack.rules, ...pack.withheld]) {
    if (ids.has(rule.id)) problems.push(`Duplicate rule id ${rule.id}.`);
    ids.add(rule.id);
    if (rule.verification.status === "needs-manual-verification" && rule.enabled) {
      problems.push(`${rule.id} needs manual verification and must be disabled.`);
    }
  }
  for (const rule of pack.withheld) {
    if (rule.enabled) problems.push(`Withheld rule ${rule.id} is enabled.`);
    if (rule.verification.status === "verified") {
      problems.push(`Withheld rule ${rule.id} is marked verified. Move it to rules.yaml or mark it needs-manual-verification.`);
    }
  }
  const covered = new Set(pack.cases.map((item) => item.rule));
  for (const rule of pack.rules) {
    if (rule.enabled && !covered.has(rule.id)) problems.push(`Enabled rule ${rule.id} has no test case.`);
  }
  for (const item of pack.cases) {
    if (!ids.has(item.rule)) problems.push(`Case ${item.id} points at unknown rule ${item.rule}.`);
  }
  return problems;
}

export function evaluatePack(
  pack: LoadedPack,
  facts: Readonly<Record<string, FactValue>>,
  evidence: readonly Evidence[],
  now = new Date(),
  staleDays = STALE_DAYS_DEFAULT,
): Evaluation {
  const findings = pack.rules.filter((rule) => rule.enabled).map((rule) => evaluateRule(rule, facts, evidence, now, staleDays));
  const withheld = pack.withheld.map((rule) => ({
    ruleId: rule.id,
    title: rule.title,
    reason: rule.verification.note ?? rule.summary.en,
    sourceUrl: rule.source.url,
    sourceSection: rule.source.section,
  }));
  return { findings, withheld };
}

export function evaluateRule(
  rule: Rule,
  facts: Readonly<Record<string, FactValue>>,
  evidence: readonly Evidence[],
  now = new Date(),
  staleDays = STALE_DAYS_DEFAULT,
): Finding {
  let status: FindingStatus = "not_applicable";
  if (matchCondition(rule.appliesWhen, facts)) {
    if (rule.evaluate.pass && matchCondition(rule.evaluate.pass, facts)) status = "pass";
    else if (rule.evaluate.fail && matchCondition(rule.evaluate.fail, facts)) status = "fail";
    else status = "unchecked";
  }
  const referenced = factsReferenced(rule.appliesWhen);
  factsReferenced(rule.evaluate.pass, referenced);
  factsReferenced(rule.evaluate.fail, referenced);
  const attached = evidence.filter((item) => item.facts.some((fact) => referenced.has(fact)));
  const verifiedAt = rule.verification.verifiedAt ?? null;
  return {
    ruleId: rule.id,
    title: rule.title,
    status,
    severity: rule.severity,
    origin: rule.origin,
    confidence: rule.check.confidence,
    summaryEn: rule.summary.en,
    summaryTr: rule.summary.tr,
    sourceUrl: rule.source.url,
    sourceSection: rule.source.section,
    sourcePublisher: rule.source.publisher,
    verifiedAt,
    stale: verifiedAt ? isStale(verifiedAt, now, staleDays) : false,
    checkNote: rule.check.note,
    evidence: attached,
    fix: rule.fix ?? null,
  };
}

export function runCases(pack: LoadedPack, now = new Date("2026-11-19T00:00:00Z")): Array<{ id: string; rule: string; expected: RuleCase["expect"]; actual: FindingStatus }> {
  const byId = new Map(pack.rules.concat(pack.withheld).map((rule) => [rule.id, rule]));
  return pack.cases.map((item) => {
    const rule = byId.get(item.rule);
    if (!rule) return { id: item.id, rule: item.rule, expected: item.expect, actual: "unchecked" };
    const finding = evaluateRule(rule, item.facts, [], now);
    return { id: item.id, rule: item.rule, expected: item.expect, actual: finding.status };
  });
}
