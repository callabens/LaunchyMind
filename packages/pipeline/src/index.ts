import {
  DISCLAIMERS,
  findCorePackDir,
  LAUNCHYMIND_VERSION,
  NotFlutterProjectError,
  PRODUCT_NAME,
  STALE_DAYS_DEFAULT,
  VENDOR,
  type Evidence,
  type FactValue,
  type LaunchReport,
  type Limitation,
  type LiveCheckRecord,
} from "../../core/src/index.ts";
import {
  appAdsUrl,
  createNetworkChecker,
  inferredDeveloperWebsite,
  inferredSupportUrls,
  inspectPage,
  pageSignals,
  type LiveChecker,
  type LivePage,
  type PageInspection,
} from "../../live/src/index.ts";
import { loadProjectPacks } from "../../packs/src/index.ts";
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
  if (scanned.profile.framework === "unknown") throw new NotFlutterProjectError(projectPath);
  const projectPacks = await loadProjectPacks(projectPath);
  for (const problem of projectPacks.problems) {
    scanned.limitations.push({ id: "project-pack", detail: problem, blocksReady: true });
  }
  for (const pack of projectPacks.packs) {
    scanned.observations.push({
      id: `pack.loaded.${pack.meta.id}`,
      detail: `Loaded project pack ${pack.meta.id} ${pack.meta.version}.`,
    });
  }
  const merged = mergePacks(pack, projectPacks.packs, scanned.limitations);
  const offline = options.offline === true;
  const checker = offline ? null : options.liveChecker ?? createNetworkChecker();
  const live = await applyLive(scanned, checker, offline);
  const now = options.now ?? new Date();
  const evaluation = evaluatePack(merged, live.facts, live.evidence, now, options.staleDays ?? STALE_DAYS_DEFAULT);
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
    verdictHeadline: decision.headline,
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
  const privacyInspection = privacy.page ? inspectPage(privacy.page.text, names) : null;
  assignPage(facts, evidence, privacy, privacyInspection, "live.privacy.status", {
    collection: "live.privacy.collection",
    deletion: "live.privacy.deletion",
    consent: "live.privacy.consent",
    ads: "live.privacy.ads",
    controller: "live.privacy.controller",
    purpose: "live.privacy.purpose",
    transfer: "live.privacy.transfer",
    legalBasis: "live.privacy.legal_basis",
    rights: "live.privacy.rights",
    notForChildren: "live.privacy.not_for_children",
  }, names, () => {
    next += 1;
    return `ev_live_${next}`;
  });

  let supportTarget = scanned.liveTargets.support;
  let support = await checkOne(checker, offline, supportTarget);
  if (!supportTarget && scanned.liveTargets.privacy && checker && !offline) {
    for (const candidate of inferredSupportUrls(scanned.liveTargets.privacy)) {
      const probed = await checker.check(candidate);
      const contact = pageSignals(probed.text, names).contact;
      if (!(probed.status === "ok" && contact === "yes")) {
        records.push({
          url: candidate,
          status: probed.status,
          httpStatus: probed.httpStatus,
          detail: `support probe inferred from the privacy URL: ${probed.error ?? `HTTP ${probed.httpStatus ?? "n/a"}`}`,
        });
      }
      if (probed.status === "ok" && contact === "yes") {
        supportTarget = candidate;
        support = { factStatus: probed.status, page: probed, detail: "Support page inferred from the privacy URL host and it includes a contact path." };
        facts["urls.support.present"] = true;
        evidence.push({
          id: `ev_live_support_inferred_${next}`,
          facts: ["urls.support.present", "live.support.status"],
          kind: "live",
          detail: "No support URL was declared. The privacy URL host was probed and this support page opened.",
          path: candidate,
          snippet: inspectPage(probed.text, names).snippet,
        });
        break;
      }
    }
  }
  if (supportTarget) records.push(record("support", supportTarget, support));
  facts["live.support.status"] = support.factStatus;
  facts["live.support.contact"] = support.page ? pageSignals(support.page.text, names).contact : support.factStatus === "not-applicable" ? "not-applicable" : "unknown";
  if (support.page) {
    pushLiveEvidence(evidence, ["live.support.status", "live.support.contact"], support, () => `ev_live_support_${next}`, inspectPage(support.page?.text ?? "", names).snippet);
  } else {
    pushLiveEvidence(evidence, ["live.support.status"], support, () => `ev_live_support_${next}`);
  }

  const deletion = await checkOne(checker, offline, scanned.liveTargets.accountDeletion);
  records.push(record("account-deletion", scanned.liveTargets.accountDeletion, deletion));
  facts["live.account_deletion.status"] = deletion.factStatus;
  facts["live.account_deletion.mentions_name"] = deletion.page ? pageSignals(deletion.page.text, names).mentionsName : deletion.factStatus === "not-applicable" ? "not-applicable" : "unknown";
  pushLiveEvidence(evidence, ["live.account_deletion.status", "live.account_deletion.mentions_name"], deletion, () => `ev_live_deletion_${next}`);

  const declaredSite = scanned.liveTargets.developerWebsite;
  const website = declaredSite ?? (scanned.liveTargets.privacy ? inferredDeveloperWebsite(scanned.liveTargets.privacy) : null);
  const adsTarget = facts["capability.ads"] === true && website ? appAdsUrl(website) : null;
  const ads = await checkOne(checker, offline, facts["capability.ads"] === true ? adsTarget : null);
  if (facts["capability.ads"] !== true) {
    facts["live.app_ads.status"] = "not-applicable";
    facts["live.app_ads.google"] = "not-applicable";
  } else if (!adsTarget) {
    facts["live.app_ads.status"] = "unknown";
    facts["live.app_ads.google"] = "unknown";
    records.push({ url: "", status: "unknown", httpStatus: null, detail: "No developer website was declared and no privacy URL was available to infer one, so app-ads.txt was not requested." });
  } else {
    records.push(record("app-ads", adsTarget, ads));
    facts["live.app_ads.status"] = ads.factStatus === "ok" && ads.page && ads.page.text.trim().length === 0 ? "missing" : ads.factStatus;
    const text = ads.page?.text ?? "";
    facts["live.app_ads.google"] = facts["live.app_ads.status"] === "ok" ? (/google\.com/i.test(text) ? "yes" : "no") : "unknown";
    if (!declaredSite && website) {
      evidence.push({
        id: `ev_live_site_${next}`,
        facts: ["live.app_ads.status"],
        kind: "live",
        detail: "Developer website was not declared. app-ads.txt was requested at the privacy URL's host.",
        path: website,
      });
    }
    pushLiveEvidence(evidence, ["live.app_ads.status"], ads, () => `ev_live_ads_${next}`, text.slice(0, 180));
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
  inspection: PageInspection | null,
  statusFact: string,
  signalFacts: Record<string, string>,
  names: string[],
  id: () => string,
): void {
  facts[statusFact] = checked.factStatus;
  const signals = inspection?.signals ?? (checked.page && (checked.page.status === "ok" || checked.page.status === "placeholder") ? pageSignals(checked.page.text, names) : null);
  for (const [signal, fact] of Object.entries(signalFacts)) {
    if (checked.factStatus === "not-applicable") facts[fact] = "not-applicable";
    else if (!signals) facts[fact] = "unknown";
    else facts[fact] = signals[signal as keyof typeof signals] ?? "unknown";
  }
  const noted = inspection
    ? { ...checked, detail: `${checked.detail}. ${inspection.summary}` }
    : checked;
  pushLiveEvidence(evidence, [statusFact, ...Object.values(signalFacts)], noted, id, inspection?.snippet);
}

function pushLiveEvidence(evidence: Evidence[], facts: string[], checked: Checked, id: () => string, snippetOverride?: string): void {
  if (!checked.page && checked.factStatus === "not-applicable") return;
  const snippet = (snippetOverride ?? checked.page?.text.slice(0, 180) ?? "").slice(0, 280);
  evidence.push({
    id: id(),
    facts,
    kind: "live",
    detail: checked.detail,
    ...(checked.page ? { path: checked.page.url } : {}),
    ...(snippet ? { snippet } : {}),
  });
}

function mergePacks(core: LoadedPack, extras: readonly LoadedPack[], limitations: Limitation[]): LoadedPack {
  const ids = new Set(core.rules.map((rule) => rule.id));
  const extraRules = [];
  for (const pack of extras) {
    const kept = [];
    for (const rule of pack.rules) {
      if (ids.has(rule.id)) {
        limitations.push({
          id: "project-pack-duplicate",
          detail: `Project pack ${pack.meta.id} repeats core rule ${rule.id}, so that copy was not loaded.`,
          blocksReady: false,
        });
        continue;
      }
      ids.add(rule.id);
      kept.push(rule);
    }
    extraRules.push(...kept);
  }
  return {
    ...core,
    rules: [...core.rules, ...extraRules],
    withheld: [...core.withheld, ...extras.flatMap((pack) => pack.withheld)],
  };
}

function record(label: string, url: string | null, checked: Checked): LiveCheckRecord {
  return {
    url: url ?? "",
    status: String(checked.factStatus),
    httpStatus: checked.page?.httpStatus ?? null,
    detail: `${label}: ${checked.detail}`,
  };
}
