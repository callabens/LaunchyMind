import {
  DISCLAIMERS,
  findCorePackDir,
  LAUNCHYMIND_VERSION,
  PRODUCT_NAME,
  STALE_DAYS_DEFAULT,
  VENDOR,
  type Evidence,
  type FactValue,
  type LaunchReport,
  type LiveCheckRecord,
} from "../../core/src/index.ts";
import { appAdsUrl, createNetworkChecker, pageSignals, type LiveChecker, type LivePage } from "../../live/src/index.ts";
import { evaluatePack, loadPack, type LoadedPack } from "../../rules/src/index.ts";
import { scanProject, type ScanResult } from "../../scan/src/index.ts";
import { decideVerdict } from "../../verdict/src/index.ts";

export interface RunOptions {
  offline?: boolean;
  now?: Date;
  staleDays?: number;
  liveChecker?: LiveChecker;
  packDir?: string;
  pack?: LoadedPack;
}

export async function runScan(projectPath: string, options: RunOptions = {}): Promise<LaunchReport> {
  const pack = options.pack ?? await loadPack(options.packDir ?? findCorePackDir());
  const scanned = await scanProject(projectPath, pack.directory);
  const offline = options.offline === true;
  const checker = offline ? null : options.liveChecker ?? createNetworkChecker();
  const live = await applyLive(scanned, checker, offline);
  const now = options.now ?? new Date();
  const evaluation = evaluatePack(pack, live.facts, live.evidence, now, options.staleDays ?? STALE_DAYS_DEFAULT);
  const decision = decideVerdict(evaluation.findings, scanned.limitations);
  return {
    version: 1,
    product: PRODUCT_NAME,
    vendor: VENDOR,
    toolVersion: LAUNCHYMIND_VERSION,
    generatedAt: now.toISOString(),
    projectPath,
    offline,
    profile: scanned.profile,
    pack: {
      id: pack.meta.id,
      name: pack.meta.name,
      version: pack.meta.version,
      verifiedAt: pack.meta.verifiedAt,
    },
    verdict: decision.verdict,
    verdictBecause: decision.because,
    disclaimers: [...DISCLAIMERS],
    findings: evaluation.findings,
    withheld: evaluation.withheld,
    limitations: scanned.limitations,
    observations: scanned.observations,
    facts: live.facts,
    live: live.records,
  };
}

async function applyLive(scanned: ScanResult, checker: LiveChecker | null, offline: boolean): Promise<{ facts: Record<string, FactValue>; evidence: Evidence[]; records: LiveCheckRecord[] }> {
  const facts = { ...scanned.facts };
  const evidence = [...scanned.evidence];
  const records: LiveCheckRecord[] = [];
  const names = [scanned.profile.displayName, scanned.profile.name, scanned.profile.developerName].filter((item): item is string => Boolean(item));
  let next = evidence.length + 1;

  const privacy = await checkOne(checker, offline, scanned.liveTargets.privacy);
  records.push(record("privacy", scanned.liveTargets.privacy, privacy));
  assignPage(facts, evidence, privacy, "live.privacy.status", {
    collection: "live.privacy.collection",
    deletion: "live.privacy.deletion",
    consent: "live.privacy.consent",
    ads: "live.privacy.ads",
    controller: "live.privacy.controller",
    purpose: "live.privacy.purpose",
    transfer: "live.privacy.transfer",
    legalBasis: "live.privacy.legal_basis",
    rights: "live.privacy.rights",
  }, names, () => {
    next += 1;
    return `ev_live_${next}`;
  });

  const support = await checkOne(checker, offline, scanned.liveTargets.support);
  records.push(record("support", scanned.liveTargets.support, support));
  facts["live.support.status"] = support.factStatus;
  facts["live.support.contact"] = support.page ? pageSignals(support.page.text, names).contact : support.factStatus === "not-applicable" ? "not-applicable" : "unknown";
  pushLiveEvidence(evidence, ["live.support.status"], support, () => `ev_live_support_${next}`);

  const deletion = await checkOne(checker, offline, scanned.liveTargets.accountDeletion);
  records.push(record("account-deletion", scanned.liveTargets.accountDeletion, deletion));
  facts["live.account_deletion.status"] = deletion.factStatus;
  facts["live.account_deletion.mentions_name"] = deletion.page ? pageSignals(deletion.page.text, names).mentionsName : deletion.factStatus === "not-applicable" ? "not-applicable" : "unknown";
  pushLiveEvidence(evidence, ["live.account_deletion.status", "live.account_deletion.mentions_name"], deletion, () => `ev_live_deletion_${next}`);

  const adsTarget = facts["capability.ads"] === true ? appAdsUrl(scanned.liveTargets.developerWebsite ?? "") : null;
  const ads = await checkOne(checker, offline, facts["capability.ads"] === true ? adsTarget : null);
  if (facts["capability.ads"] !== true) {
    facts["live.app_ads.status"] = "not-applicable";
    facts["live.app_ads.google"] = "not-applicable";
  } else if (!adsTarget) {
    facts["live.app_ads.status"] = "unknown";
    facts["live.app_ads.google"] = "unknown";
    records.push({ url: "", status: "unknown", httpStatus: null, detail: "No developer website was declared, so app-ads.txt was not requested." });
  } else {
    records.push(record("app-ads", adsTarget, ads));
    facts["live.app_ads.status"] = ads.factStatus === "ok" && ads.page && ads.page.text.trim().length === 0 ? "missing" : ads.factStatus;
    const text = ads.page?.text ?? "";
    facts["live.app_ads.google"] = facts["live.app_ads.status"] === "ok" ? (/google\.com/i.test(text) ? "yes" : "no") : "unknown";
    pushLiveEvidence(evidence, ["live.app_ads.status"], ads, () => `ev_live_ads_${next}`);
  }

  return { facts, evidence, records };
}

interface Checked {
  factStatus: FactValue;
  page: LivePage | null;
  detail: string;
}

async function checkOne(checker: LiveChecker | null, offline: boolean, url: string | null): Promise<Checked> {
  if (!url) return { factStatus: "not-applicable", page: null, detail: "No URL was found in the project." };
  if (offline || !checker) return { factStatus: "skipped", page: null, detail: "Live checks were skipped." };
  const page = await checker.check(url);
  return { factStatus: page.status, page, detail: page.error ?? `HTTP ${page.httpStatus ?? "n/a"}` };
}

function assignPage(
  facts: Record<string, FactValue>,
  evidence: Evidence[],
  checked: Checked,
  statusFact: string,
  signalFacts: Record<string, string>,
  names: string[],
  id: () => string,
): void {
  facts[statusFact] = checked.factStatus;
  const signals = checked.page && (checked.page.status === "ok" || checked.page.status === "placeholder") ? pageSignals(checked.page.text, names) : null;
  for (const [signal, fact] of Object.entries(signalFacts)) {
    if (checked.factStatus === "not-applicable") facts[fact] = "not-applicable";
    else if (!signals) facts[fact] = "unknown";
    else facts[fact] = signals[signal as keyof typeof signals] ?? "unknown";
  }
  pushLiveEvidence(evidence, [statusFact, ...Object.values(signalFacts)], checked, id);
}

function pushLiveEvidence(evidence: Evidence[], facts: string[], checked: Checked, id: () => string): void {
  if (!checked.page && checked.factStatus === "not-applicable") return;
  const snippet = checked.page?.text.slice(0, 180);
  evidence.push({
    id: id(),
    facts,
    kind: "live",
    detail: checked.detail,
    ...(checked.page ? { path: checked.page.url } : {}),
    ...(snippet ? { snippet } : {}),
  });
}

function record(label: string, url: string | null, checked: Checked): LiveCheckRecord {
  return {
    url: url ?? "",
    status: String(checked.factStatus),
    httpStatus: checked.page?.httpStatus ?? null,
    detail: `${label}: ${checked.detail}`,
  };
}
