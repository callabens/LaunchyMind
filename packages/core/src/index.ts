import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const LAUNCHYMIND_VERSION = "1.0.1";
export const LAUNCHPACK_SCHEMA_VERSION = 1;
export const PRODUCT_NAME = "LaunchyMind";
export const VENDOR = "callabens";

export const DISCLAIMERS = [
  "This is not store approval. Apple and Google make the final decision.",
  "This is not legal advice. Ask a lawyer before you rely on it.",
  "Ready means every applicable enabled rule in this pack was checked and passed. It does not mean the app will be accepted.",
] as const;

export const LAWYER_WARNING =
  "DRAFT ONLY. This is not legal advice and not a finished policy. Ask a lawyer before you publish it.";

export const STALE_DAYS_DEFAULT = 180;

export type FactValue = boolean | number | string;
export type Severity = "blocker" | "risk" | "info";
export type FindingStatus = "pass" | "fail" | "unchecked" | "not_applicable";
export type Verdict = "ready" | "risky" | "reject";
export type Confidence = "direct" | "heuristic" | "attestation";
export type Origin = "store" | "legal" | "industry" | "product";
export type EvidenceKind = "file" | "dependency" | "url" | "attestation" | "absence" | "live" | "scan";

export interface Evidence {
  id: string;
  facts: string[];
  kind: EvidenceKind;
  detail: string;
  path?: string;
  line?: number;
  snippet?: string;
}

export interface Observation {
  id: string;
  detail: string;
  path?: string;
  line?: number;
}

export interface Limitation {
  id: string;
  detail: string;
  blocksReady: boolean;
}

export interface AppProfile {
  framework: "flutter" | "react-native" | "expo" | "ios" | "android" | "unity" | "native" | "unknown";
  name: string | null;
  version: string | null;
  displayName: string | null;
  developerName: string | null;
  platforms: { ios: boolean; android: boolean };
  dependencies: Array<{ name: string; spec: string | null; line: number | null }>;
  capabilities: Array<{ id: string; present: boolean | "unknown" }>;
  permissions: {
    ios: Array<{ key: string; present: boolean; line: number | null }>;
    android: string[];
  };
  urls: {
    privacy: string[];
    support: string[];
    accountDeletion: string[];
    developerWebsite: string[];
  };
  metadata: {
    applicationId: string | null;
    targetSdk: number | null;
    minSdk: number | null;
    compileSdk: number | null;
    iosDeploymentTargets: string[];
  };
  unknowns: string[];
}

export interface Comparator {
  fact: string;
  eq?: FactValue | undefined;
  neq?: FactValue | undefined;
  gte?: number | undefined;
  lt?: number | undefined;
}

export interface AllCondition {
  all: Condition[];
}

export interface AnyCondition {
  any: Condition[];
}

export type Condition = AllCondition | AnyCondition | Comparator;

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  platforms: Array<"ios" | "android" | "any">;
  enabled: boolean;
  origin: Origin;
  verification: {
    status: "verified" | "needs-manual-verification";
    verifiedAt?: string | undefined;
    method?: string | undefined;
    note?: string | undefined;
  };
  source: {
    url: string;
    section: string;
    publisher: string;
  };
  summary: { en: string; tr: string };
  appliesWhen: Condition;
  evaluate: {
    pass?: Condition | undefined;
    fail?: Condition | undefined;
  };
  check: {
    confidence: Confidence;
    note: string;
  };
  next?: { en: string; tr: string } | undefined;
  fix?: string | undefined;
}

export interface RuleCase {
  id: string;
  rule: string;
  expect: Exclude<FindingStatus, "not_applicable">;
  facts: Record<string, FactValue>;
}

export interface PackMeta {
  format: 1;
  id: string;
  name: string;
  version: string;
  license: string;
  engine: string;
  authors: string[];
  verifiedAt: string;
  description: string;
}

export interface Finding {
  ruleId: string;
  title: string;
  status: FindingStatus;
  severity: Severity;
  origin: Origin;
  confidence: Confidence;
  summaryEn: string;
  summaryTr: string;
  sourceUrl: string;
  sourceSection: string;
  sourcePublisher: string;
  verifiedAt: string | null;
  stale: boolean;
  checkNote: string;
  nextEn: string | null;
  nextTr: string | null;
  evidence: Evidence[];
  fix: string | null;
}

export interface WithheldRule {
  ruleId: string;
  title: string;
  reason: string;
  sourceUrl: string;
  sourceSection: string;
}

export interface LiveCheckRecord {
  url: string;
  status: string;
  httpStatus: number | null;
  detail: string;
}

export interface SourceWatchItem {
  ruleId: string;
  url: string;
  excerpt: string;
}

export interface LaunchReport {
  version: 1;
  product: typeof PRODUCT_NAME;
  vendor: typeof VENDOR;
  toolVersion: string;
  generatedAt: string;
  projectPath: string;
  offline: boolean;
  profile: AppProfile;
  pack: { id: string; name: string; version: string; verifiedAt: string };
  verdict: Verdict;
  verdictHeadline: string;
  verdictBecause: string[];
  disclaimers: string[];
  findings: Finding[];
  withheld: WithheldRule[];
  limitations: Limitation[];
  observations: Observation[];
  facts: Record<string, FactValue>;
  live: LiveCheckRecord[];
  sourceWatch: { needsReverify: SourceWatchItem[] };
  /** Present only when live device checks were asked for. */
  device?: Array<{
    platform: "android" | "ios";
    artifact: string;
    appId: string | null;
    device: string | null;
    checks: Array<{ id: string; status: "pass" | "fail" | "found" | "not-found" | "not-checked" | "not-applicable"; detail: string }>;
    screenshots: string[];
  }>;
}

export const KNOWN_FACTS = [
  "framework.flutter",
  "framework.react_native",
  "framework.expo",
  "framework.ios",
  "framework.android",
  "framework.unity",
  "platform.ios",
  "platform.android",
  "capability.camera",
  "capability.photos",
  "capability.location",
  "capability.microphone",
  "capability.contacts",
  "capability.notifications",
  "capability.ads",
  "capability.tracking",
  "capability.accounts",
  "capability.third_party_login",
  "capability.non_apple_third_party_login",
  "capability.apple_sign_in",
  "capability.payments",
  "capability.analytics",
  "capability.listed_sdk",
  "audience.kids",
  "region.tr",
  "region.eu",
  "region.us",
  "legal.pack.kvkk",
  "legal.pack.gdpr",
  "legal.pack.coppa",
  "legal.pack.apple_kids",
  "legal.pack.google_families",
  "legal.pack.dsa",
  "legal.pack.accessibility",
  "attestation.coppa.notice",
  "attestation.eu.dsa_trader",
  "sdk.coverage",
  "sdk.manifest_mismatch",
  "sdk.answer_mismatch",
  "audience.health",
  "audience.ugc",
  "kvkk.explicit_consent",
  "kvkk.consent_separate",
  "ios.usage.camera",
  "ios.usage.photos",
  "ios.usage.location",
  "ios.usage.microphone",
  "ios.usage.contacts",
  "ios.usage.tracking",
  "ios.deployment_target",
  "ios.device_family",
  "ios.privacy_manifest.present",
  "ios.privacy_manifest.incomplete_reasons",
  "android.target_sdk",
  "android.min_sdk",
  "android.compile_sdk",
  "urls.privacy.in_app",
  "urls.privacy.declared",
  "urls.privacy.present",
  "urls.support.present",
  "urls.support.in_app",
  "urls.account_deletion.present",
  "urls.account_deletion.in_app",
  "urls.developer_website.present",
  "account.deletion.in_app",
  "attestation.apple.xcode_sdk",
  "attestation.apple.age_rating",
  "attestation.apple.login_exception",
  "attestation.apple.att_not_required",
  "attestation.apple.subscription_terms",
  "attestation.apple.listed_sdk_manifests",
  "attestation.google.data_safety",
  "google.account",
  "google.distribution",
  "google.closed_test",
  "payments.subscription_terms_found",
  "tracking.att_required",
  "ads.google",
  "ads.sample_unit_in_shipped_config",
  "android.ad_id",
  "attestation.google.data_safety_ad_id",
  "listed_sdk.bundled_manifests",
  "capability.game_center",
  "capability.play_games",
  "ads.ump_requested",
  "payments.stub_ui",
  "payments.subscriptions",
  "payments.restore_control",
  "payments.renewal_terms_found",
  "payments.terms_link_found",
  "attestation.payments.restore_control",
  "attestation.payments.paywall_links",
  "sdk.revenuecat",
  "revenuecat.secret_key",
  "connect.revenuecat",
  "google.data_safety_declaration",
  "build.requested",
  "build.status",
  "live.device.requested",
  "live.device.android_launch",
  "live.device.ios_launch",
  "android.target_sdk_basis",
  "ios.privacy_manifest.tracking",
  "ios.privacy_manifest.tracking_consistent",
  "live.privacy.not_for_children",
  "live.privacy.status",
  "live.privacy.collection",
  "live.privacy.deletion",
  "live.privacy.consent",
  "live.privacy.ads",
  "live.privacy.controller",
  "live.privacy.purpose",
  "live.privacy.transfer",
  "live.privacy.legal_basis",
  "live.privacy.rights",
  "live.privacy.retention",
  "live.privacy.complaint",
  "live.privacy.third_country",
  "attestation.gdpr.lawful_basis",
  "attestation.gdpr.consent_basis",
  "attestation.gdpr.processors",
  "attestation.gdpr.transfers",
  "a11y.labels",
  "attestation.accessibility.reviewed",
  "attestation.apple.accessibility_labels",
  "attestation.eaa.applies",
  "attestation.eaa.information",
  "attestation.apple.kids_parental_gate",
  "attestation.apple.kids_analytics_exception",
  "live.support.status",
  "live.support.contact",
  "live.account_deletion.status",
  "live.account_deletion.mentions_name",
  "live.app_ads.status",
  "live.app_ads.google",
  "store.ios.present",
  "store.android.present",
  "store.ios.name",
  "store.ios.subtitle",
  "store.ios.description",
  "store.ios.keywords",
  "store.ios.promo",
  "store.ios.release_notes",
  "store.android.title",
  "store.android.short_description",
  "store.android.full_description",
  "store.text.placeholder",
  "store.ios.other_platform",
  "store.android.other_platform",
  "store.text.future_promise",
  "store.copyright.year",
  "store.text.price",
  "store.keywords.stuffing",
  "store.locale.features",
  "store.ios.icon",
  "store.ios.screenshots",
  "store.android.icon",
  "store.android.feature_graphic",
  "store.android.screenshots",
  "store.urls.status",
  "connect.apple",
  "connect.google",
  "artifact.present",
  "artifact.drift",
] as const;

export type KnownFact = (typeof KNOWN_FACTS)[number];

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const factValueSchema = z.union([z.boolean(), z.number().finite(), z.string().min(1)]);

export const comparatorSchema = z.object({
  fact: z.string().regex(/^[a-z0-9_.-]+$/),
  eq: factValueSchema.optional(),
  neq: factValueSchema.optional(),
  gte: z.number().finite().optional(),
  lt: z.number().finite().optional(),
}).strict().superRefine((value, ctx) => {
  const operators = [value.eq, value.neq, value.gte, value.lt].filter((item) => item !== undefined).length;
  if (operators !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A comparison needs exactly one of eq, neq, gte, or lt." });
  }
});

export const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ all: z.array(conditionSchema).min(1) }).strict(),
  z.object({ any: z.array(conditionSchema).min(1) }).strict(),
  comparatorSchema,
]));

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.][a-z0-9-]+)+$/),
  title: z.string().min(8),
  severity: z.enum(["blocker", "risk", "info"]),
  platforms: z.array(z.enum(["ios", "android", "any"])).min(1),
  enabled: z.boolean(),
  origin: z.enum(["store", "legal", "industry", "product"]),
  verification: z.object({
    status: z.enum(["verified", "needs-manual-verification"]),
    verifiedAt: z.string().regex(datePattern).optional(),
    method: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  }).strict(),
  source: z.object({
    url: z.string().url().refine((value) => value.startsWith("https://"), "Source URLs must use https."),
    section: z.string().min(1),
    publisher: z.string().min(1),
  }).strict(),
  summary: z.object({
    en: z.string().min(20),
    tr: z.string().min(10),
  }).strict(),
  appliesWhen: conditionSchema,
  evaluate: z.object({
    pass: conditionSchema.optional(),
    fail: conditionSchema.optional(),
  }).strict(),
  check: z.object({
    confidence: z.enum(["direct", "heuristic", "attestation"]),
    note: z.string().min(10),
  }).strict(),
  next: z.object({
    en: z.string().min(10),
    tr: z.string().min(5),
  }).strict().optional(),
  fix: z.string().regex(/^[a-z0-9-]+$/).optional(),
}).strict().superRefine((rule, ctx) => {
  if (!rule.evaluate.pass && !rule.evaluate.fail) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${rule.id} needs a pass or fail condition.` });
  }
  if (rule.verification.status === "verified" && !rule.verification.verifiedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${rule.id} is verified and needs verifiedAt.` });
  }
  if (rule.enabled && rule.verification.status !== "verified") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${rule.id} is enabled but not verified. Withhold it until someone checks the source.`,
    });
  }
  if (rule.verification.status === "needs-manual-verification" && rule.enabled) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${rule.id} must stay disabled until it is verified.` });
  }
});

export const packMetaSchema = z.object({
  format: z.literal(1),
  id: z.string().regex(/^[a-z0-9.-]+$/),
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
  engine: z.string().min(1),
  authors: z.array(z.string().min(1)).min(1),
  verifiedAt: z.string().regex(datePattern),
  description: z.string().min(1),
}).strict();

export const ruleCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  rule: z.string().min(1),
  expect: z.enum(["pass", "fail", "unchecked"]),
  facts: z.record(factValueSchema),
}).strict();

export function isComparator(condition: Condition): condition is Comparator {
  return "fact" in condition;
}

export function matchCondition(condition: Condition, facts: Readonly<Record<string, FactValue>>): boolean {
  if (isComparator(condition)) {
    const value = Object.prototype.hasOwnProperty.call(facts, condition.fact) ? facts[condition.fact]! : "unknown";
    if (condition.eq !== undefined) return value === condition.eq;
    if (condition.neq !== undefined) return value !== condition.neq;
    if (condition.gte !== undefined) return typeof value === "number" && value >= condition.gte;
    if (condition.lt !== undefined) return typeof value === "number" && value < condition.lt;
    return false;
  }
  if ("all" in condition) return condition.all.every((child) => matchCondition(child, facts));
  return condition.any.some((child) => matchCondition(child, facts));
}

export function factsReferenced(condition: Condition | undefined, into = new Set<string>()): Set<string> {
  if (!condition) return into;
  if (isComparator(condition)) {
    into.add(condition.fact);
    return into;
  }
  const children = "all" in condition ? condition.all : condition.any;
  for (const child of children) factsReferenced(child, into);
  return into;
}

export function isStale(verifiedAt: string, now: Date, staleDays: number): boolean {
  const verified = new Date(`${verifiedAt}T00:00:00Z`);
  if (Number.isNaN(verified.getTime())) return true;
  return now.getTime() - verified.getTime() > staleDays * 24 * 60 * 60 * 1000;
}

export type FailOn = "reject" | "risky" | "none";

export function parseFailOn(value: string | undefined): FailOn {
  if (value === undefined || value === "reject") return "reject";
  if (value === "risky" || value === "none") return value;
  throw new Error("`--fail-on` must be reject, risky, or none.");
}

/** Exit code for a finished scan. Usage problems use other codes and never call this. */
export function exitCodeForVerdict(verdict: Verdict, failOn: FailOn = "reject"): number {
  if (failOn === "none" || verdict === "ready") return 0;
  if (verdict === "risky") return failOn === "risky" ? 2 : 0;
  return 3;
}

export class NotFlutterProjectError extends Error {
  readonly exitCode = 4;
  constructor(projectPath: string) {
    super(`Not a Flutter project: ${projectPath}. Nothing here matches Flutter, React Native, Expo, a native iOS or Android app, or a Unity project. The scan stopped before a verdict.`);
    this.name = "NotFlutterProjectError";
  }
}

export function findCorePackDir(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "packages", "packs", "core");
    if (existsSync(join(candidate, "pack.yaml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("LaunchyMind core rule pack was not found. Expected packages/packs/core/pack.yaml.");
}

export function emptyFacts(): Record<string, FactValue> {
  const facts: Record<string, FactValue> = {};
  for (const fact of KNOWN_FACTS) facts[fact] = "unknown";
  return facts;
}
