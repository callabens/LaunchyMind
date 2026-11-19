import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  emptyFacts,
  type AppProfile,
  type Evidence,
  type FactValue,
  type Limitation,
  type Observation,
} from "../../core/src/index.ts";

const capabilitySchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
  iosUsage: z.array(z.string().min(1)),
  androidPermissions: z.array(z.string().min(1)),
}).strict();

const signaturesSchema = z.object({
  format: z.literal(1),
  ignoredPackages: z.array(z.string().min(1)),
  capabilities: z.record(z.string(), capabilitySchema),
  listedSdks: z.array(z.object({ pub: z.string().min(1), appleName: z.string().min(1) }).strict()),
  thirdPartyLogin: z.array(z.string().min(1)),
  appleSignIn: z.array(z.string().min(1)),
  googleAds: z.array(z.string().min(1)),
  deletionNeedles: z.array(z.string().min(1)).min(1),
  subscriptionNeedles: z.array(z.string().min(1)).min(1),
  priceNeedles: z.array(z.string().min(1)).min(1),
  urlNeedles: z.object({
    privacy: z.array(z.string().min(1)).min(1),
    support: z.array(z.string().min(1)).min(1),
    accountDeletion: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

const projectSchema = z.object({
  appName: z.string().min(1).max(200).optional(),
  developerName: z.string().min(1).max(200).optional(),
  audience: z.object({
    kids: z.boolean().optional(),
    health: z.boolean().optional(),
    userGeneratedContent: z.boolean().optional(),
  }).strict().optional(),
  kvkk: z.object({
    explicitConsent: z.boolean().optional(),
    consentSeparate: z.boolean().optional(),
  }).strict().optional(),
  urls: z.object({
    privacy: z.string().url().optional(),
    support: z.string().url().optional(),
    accountDeletion: z.string().url().optional(),
    developerWebsite: z.string().url().optional(),
  }).strict().optional(),
  attestations: z.object({
    "apple.xcode-sdk": z.boolean().optional(),
    "apple.age-rating": z.boolean().optional(),
    "apple.login-exception": z.boolean().optional(),
    "apple.att-not-required": z.boolean().optional(),
    "apple.subscription-terms": z.boolean().optional(),
    "apple.listed-sdk-manifests": z.boolean().optional(),
    "google.data-safety-form": z.boolean().optional(),
  }).strict().optional(),
  google: z.object({
    account: z.enum(["organization", "personal-before-2023-11-13", "personal-after-2023-11-13"]).optional(),
    distribution: z.enum(["internal-only", "production", "closed", "open"]).optional(),
    closedTest: z.boolean().optional(),
  }).strict().optional(),
}).strict();

type Signatures = z.infer<typeof signaturesSchema>;
type ProjectConfig = z.infer<typeof projectSchema>;

export interface LiveTargets {
  privacy: string | null;
  support: string | null;
  accountDeletion: string | null;
  developerWebsite: string | null;
}

export interface ScanResult {
  profile: AppProfile;
  facts: Record<string, FactValue>;
  evidence: Evidence[];
  observations: Observation[];
  limitations: Limitation[];
  liveTargets: LiveTargets;
}

interface PackageHit {
  name: string;
  spec: string | null;
  path: string;
  line: number | null;
}

class EvidenceBag {
  private items: Evidence[] = [];
  private next = 1;

  add(input: Omit<Evidence, "id">): void {
    const primary = input.facts[0];
    if (primary && this.items.filter((item) => item.facts.includes(primary)).length >= 8) return;
    this.items.push({ ...input, id: `ev_${this.next}` });
    this.next += 1;
  }

  all(): Evidence[] {
    return this.items;
  }
}

export async function scanProject(projectPath: string, packDir: string): Promise<ScanResult> {
  const rootInfo = await stat(projectPath).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error(`Project path is not a directory: ${projectPath}`);
  const signatures = await loadSignatures(packDir);
  const facts = emptyFacts();
  const bag = new EvidenceBag();
  const observations: Observation[] = [];
  const limitations: Limitation[] = [];
  const unknowns: string[] = [];

  const pubspecText = await readText(join(projectPath, "pubspec.yaml"), 1_000_000);
  const pubspec = pubspecText === null ? null : parseYaml(pubspecText);
  const pubspecKnown = Boolean(pubspec && typeof pubspec === "object");
  const lockText = await readText(join(projectPath, "pubspec.lock"), 5_000_000);
  const lock = lockText === null ? null : parseYaml(lockText);
  const packages = collectPackages(pubspecText, pubspec, lockText, lock);
  const flutter = isFlutter(pubspec, lock);
  facts["framework.flutter"] = flutter;
  if (!flutter) unknowns.push("This folder does not look like a Flutter project.");

  const ios = await isDir(join(projectPath, "ios"));
  const android = await isDir(join(projectPath, "android"));
  facts["platform.ios"] = ios;
  facts["platform.android"] = android;

  const dartFiles = await collectFiles(join(projectPath, "lib"), 200, (name) => name.endsWith(".dart"));
  const dartScanned = await isDir(join(projectPath, "lib"));
  const imported = new Set<string>();
  let deletion = false;
  let subscription = false;
  let price = false;
  const inAppUrls = { privacy: [] as string[], support: [] as string[], accountDeletion: [] as string[] };

  for (const file of dartFiles) {
    const text = await readText(file, 200_000);
    if (text === null) continue;
    const display = rel(projectPath, file);
    for (const match of text.matchAll(/import\s+['"]package:([A-Za-z0-9_]+)\//g)) {
      const name = match[1];
      if (!name) continue;
      imported.add(name);
      const index = match.index ?? 0;
      bag.add(fileEv([`import.${name}`], `Dart import of package:${name}`, display, lineAt(text, index), lineText(text, index)));
    }
    const lower = text.toLowerCase();
    if (signatures.deletionNeedles.some((needle) => lower.includes(needle.toLowerCase()))) {
      deletion = true;
      const needle = signatures.deletionNeedles.find((item) => lower.includes(item.toLowerCase())) ?? "delete";
      const index = lower.indexOf(needle.toLowerCase());
      bag.add(fileEv(["account.deletion.in_app"], `Account deletion text includes "${needle}".`, display, lineAt(text, index), lineText(text, index)));
    }
    if (signatures.subscriptionNeedles.some((needle) => lower.includes(needle.toLowerCase()))) subscription = true;
    if (signatures.priceNeedles.some((needle) => lower.includes(needle.toLowerCase()))) price = true;
    collectUrls(text, signatures, display, inAppUrls, bag);
  }

  const knownPackages = new Set<string>([...packages.map((item) => item.name), ...imported]);
  for (const name of imported) {
    if (!packages.some((item) => item.name === name)) {
      packages.push({ name, spec: null, path: "lib", line: null });
    }
  }

  const plist = ios ? await readPlist(join(projectPath, "ios", "Runner", "Info.plist")) : null;
  if (ios && !plist) unknowns.push("ios/Runner/Info.plist was missing or could not be read.");
  const usage = new Map<string, { value: string; line: number }>();
  if (plist) {
    for (const [key, value] of plist.entries) usage.set(key, value);
  }

  for (const [id, spec] of Object.entries(signatures.capabilities)) {
    const used = spec.packages.some((name) => knownPackages.has(name));
    const declared = spec.iosUsage.some((key) => {
      const entry = usage.get(key);
      return Boolean(entry && entry.value.trim());
    });
    facts[`capability.${id}`] = used || declared;
    if (used) {
      const hit = packages.find((item) => spec.packages.includes(item.name));
      if (hit) {
        bag.add({
          facts: [`capability.${id}`],
          kind: "dependency",
          detail: `Package ${hit.name} maps to the ${id} capability.`,
          path: hit.path,
          ...(hit.line === null ? {} : { line: hit.line }),
          ...(hit.spec ? { snippet: hit.spec } : {}),
        });
      }
    }
  }

  const listed = signatures.listedSdks.filter((item) => knownPackages.has(item.pub));
  facts["capability.listed_sdk"] = listed.length > 0;
  for (const item of listed) {
    bag.add({
      facts: ["capability.listed_sdk"],
      kind: "dependency",
      detail: `${item.pub} matches Apple's listed SDK name ${item.appleName}. The packaged list is a Flutter-relevant subset copied on 2026-11-19, not the full Apple list.`,
      path: "pubspec.yaml",
    });
  }

  const nonApple = signatures.thirdPartyLogin.filter((name) => !signatures.appleSignIn.includes(name) && knownPackages.has(name));
  const applePackage = signatures.appleSignIn.some((name) => knownPackages.has(name));
  facts["capability.third_party_login"] = nonApple.length > 0 || applePackage;
  facts["capability.non_apple_third_party_login"] = nonApple.length > 0;
  facts["capability.apple_sign_in"] = applePackage;
  facts["ads.google"] = signatures.googleAds.some((name) => knownPackages.has(name));

  if (!pubspecKnown) {
    for (const id of Object.keys(signatures.capabilities)) facts[`capability.${id}`] = "unknown";
    facts["capability.listed_sdk"] = "unknown";
    facts["capability.third_party_login"] = "unknown";
    facts["capability.non_apple_third_party_login"] = "unknown";
    facts["capability.apple_sign_in"] = "unknown";
    facts["ads.google"] = "unknown";
  }

  const ignored = new Set(signatures.ignoredPackages);
  const recognized = new Set<string>([
    ...Object.values(signatures.capabilities).flatMap((item) => item.packages),
    ...signatures.listedSdks.map((item) => item.pub),
    ...signatures.thirdPartyLogin,
    ...signatures.appleSignIn,
    ...signatures.googleAds,
  ]);
  for (const item of packages) {
    if (ignored.has(item.name) || recognized.has(item.name) || item.name === "flutter") continue;
    observations.push({
      id: `package.unrecognized.${item.name}`,
      detail: `Package ${item.name} is not in the core capability map. It did not select extra rules. Add it to a pack if it implies a store or privacy duty.`,
      path: item.path,
      ...(item.line === null ? {} : { line: item.line }),
    });
  }

  assignUsage(facts, bag, ios, plist, signatures);
  await assignDeploymentTarget(facts, bag, projectPath, ios, unknowns);
  await assignPrivacyManifests(facts, bag, projectPath, ios);
  const entitlements = ios ? await collectFiles(join(projectPath, "ios"), 20, (name) => name.endsWith(".entitlements"), new Set(["Pods", ".symlinks", "build"])) : [];
  for (const file of entitlements) {
    const text = await readText(file, 200_000);
    if (text?.includes("com.apple.developer.applesignin")) {
      facts["capability.apple_sign_in"] = true;
      bag.add(fileEv(["capability.apple_sign_in"], "Entitlements include Sign in with Apple.", rel(projectPath, file), null, "com.apple.developer.applesignin"));
    }
  }

  const manifestText = android ? await readText(join(projectPath, "android", "app", "src", "main", "AndroidManifest.xml"), 1_000_000) : null;
  const androidPermissions = manifestText ? readAndroidPermissions(manifestText) : [];
  const applicationId = manifestText ? readXmlAttr(manifestText, "package") : null;
  if (android && manifestText === null) unknowns.push("android/app/src/main/AndroidManifest.xml was missing or could not be read.");
  if (manifestText?.includes("uses-permission") && androidPermissions.length === 0) {
    unknowns.push("AndroidManifest.xml mentions uses-permission but no android:name values were read.");
  }
  for (const permission of androidPermissions) {
    const spec = Object.entries(signatures.capabilities).find(([, value]) => value.androidPermissions.includes(permission));
    if (!spec) continue;
    const [id] = spec;
    if (facts[`capability.${id}`] !== true) {
      observations.push({
        id: `android.permission.${id}`,
        detail: `${permission} is in the Android manifest, and no mapped Dart package was found. iOS purpose-string rules are not applied from an Android permission alone.`,
        path: "android/app/src/main/AndroidManifest.xml",
      });
    }
  }

  const gradle = await readGradle(projectPath);
  if (android && !gradle.found) unknowns.push("android/app/build.gradle was missing or could not be read.");
  facts["android.target_sdk"] = gradle.targetSdk ?? "unknown";
  facts["android.min_sdk"] = gradle.minSdk ?? "unknown";
  facts["android.compile_sdk"] = gradle.compileSdk ?? "unknown";
  if (gradle.targetSdk !== null) {
    bag.add(fileEv(["android.target_sdk"], `targetSdk is ${gradle.targetSdk}.`, gradle.path ?? "android/app/build.gradle", gradle.targetLine, String(gradle.targetSdk)));
  }
  if (gradle.conflict) unknowns.push("Gradle targetSdk values disagree. The target API was left unknown instead of picking one.");

  const stringsText = android ? await readText(join(projectPath, "android", "app", "src", "main", "res", "values", "strings.xml"), 500_000) : null;
  if (stringsText) collectAndroidStrings(stringsText, signatures, inAppUrls, bag);

  const configPath = join(projectPath, ".launchymind", "project.yaml");
  const configText = await readText(configPath, 200_000);
  let config: ProjectConfig | null = null;
  if (configText !== null) {
    const parsed = projectSchema.safeParse(parseYaml(configText));
    if (!parsed.success) {
      unknowns.push(` .launchymind/project.yaml was ignored because it is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`.trim());
    } else config = parsed.data;
  }

  applyConfig(facts, bag, config);
  applyUrls(facts, bag, inAppUrls, config);

  const accounts = facts["capability.accounts"] === true;
  if (!accounts) facts["account.deletion.in_app"] = facts["capability.accounts"] === false ? "not-applicable" : "unknown";
  else if (!dartScanned) facts["account.deletion.in_app"] = "unknown";
  else facts["account.deletion.in_app"] = deletion || inAppUrls.accountDeletion.length > 0;
  if (accounts && dartScanned && facts["account.deletion.in_app"] === false) {
    bag.add({
      facts: ["account.deletion.in_app"],
      kind: "absence",
      detail: "lib/ was scanned and no account-deletion symbol, phrase, or in-app deletion URL was found.",
      path: "lib",
    });
  }

  if (facts["capability.payments"] !== true) facts["payments.subscription_terms_found"] = facts["capability.payments"] === false ? "not-applicable" : "unknown";
  else if (!dartScanned) facts["payments.subscription_terms_found"] = "unknown";
  else facts["payments.subscription_terms_found"] = subscription && price;

  if (facts["attestation.apple.att_not_required"] === "yes") facts["tracking.att_required"] = "no";
  else if (facts["capability.ads"] === true || facts["capability.tracking"] === true) facts["tracking.att_required"] = "yes";
  else if (facts["capability.ads"] === "unknown" || facts["capability.tracking"] === "unknown") facts["tracking.att_required"] = "unknown";
  else facts["tracking.att_required"] = "no";

  if (lockText === null && flutter) {
    limitations.push({
      id: "pubspec-lock-not-read",
      detail: "pubspec.lock was not found, so only direct pubspec.yaml dependencies and Dart imports were used.",
      blocksReady: false,
    });
  }
  if (ios && flutter) {
    limitations.push({
      id: "flutter-sdk-manifest-not-scanned",
      detail: "The Flutter SDK is on Apple's third-party SDK list. This version does not inspect the Flutter engine privacy manifest inside the SDK or a built app.",
      blocksReady: false,
    });
  }
  if (ios) {
    limitations.push({
      id: "required-reason-apis-not-fully-scanned",
      detail: "Required-reason API use in Dart and native code is not fully scanned. Absence of a privacy manifest is not treated as a pass.",
      blocksReady: false,
    });
    limitations.push({
      id: "app-store-connect-not-queried",
      detail: "App Store Connect was not queried. Metadata answers come only from the project and from .launchymind/project.yaml.",
      blocksReady: false,
    });
  }
  if (android) {
    limitations.push({
      id: "phone-form-factor",
      detail: "Target API checks assume a phone or tablet app. Wear OS, Android TV, Automotive, and XR use different API levels and were not detected.",
      blocksReady: false,
    });
    limitations.push({
      id: "merged-manifest-not-scanned",
      detail: "Only the source AndroidManifest is read. Permissions merged from libraries at build time are not visible here.",
      blocksReady: false,
    });
  }
  limitations.push({
    id: "dart-surface-scan",
    detail: "Dart is scanned for imports and selected phrases. It is not type-checked and it is not executed.",
    blocksReady: false,
  });

  const displayName = config?.appName ?? plist?.entries.get("CFBundleDisplayName")?.value ?? plist?.entries.get("CFBundleName")?.value ?? null;
  const name = stringField(pubspec, "name");
  const version = stringField(pubspec, "version");
  const profile: AppProfile = {
    framework: flutter ? "flutter" : "unknown",
    name,
    version,
    displayName: displayName ?? name,
    developerName: config?.developerName ?? null,
    platforms: { ios, android },
    dependencies: packages.map((item) => ({ name: item.name, spec: item.spec, line: item.line })),
    capabilities: capabilityRows(facts),
    permissions: {
      ios: iosUsageRows(signatures, usage),
      android: androidPermissions,
    },
    urls: {
      privacy: unique([...(config?.urls?.privacy ? [config.urls.privacy] : []), ...inAppUrls.privacy]),
      support: unique([...(config?.urls?.support ? [config.urls.support] : []), ...inAppUrls.support]),
      accountDeletion: unique([...(config?.urls?.accountDeletion ? [config.urls.accountDeletion] : []), ...inAppUrls.accountDeletion]),
      developerWebsite: config?.urls?.developerWebsite ? [config.urls.developerWebsite] : [],
    },
    metadata: {
      applicationId: gradle.applicationId ?? applicationId,
      targetSdk: gradle.targetSdk,
      minSdk: gradle.minSdk,
      compileSdk: gradle.compileSdk,
      iosDeploymentTargets: typeof facts["ios.deployment_target"] === "number" ? [String(facts["ios.deployment_target"])] : [],
    },
    unknowns,
  };

  return {
    profile,
    facts,
    evidence: bag.all(),
    observations,
    limitations,
    liveTargets: {
      privacy: inAppUrls.privacy[0] ?? config?.urls?.privacy ?? null,
      support: inAppUrls.support[0] ?? config?.urls?.support ?? null,
      accountDeletion: inAppUrls.accountDeletion[0] ?? config?.urls?.accountDeletion ?? null,
      developerWebsite: config?.urls?.developerWebsite ?? null,
    },
  };
}

function capabilityRows(facts: Record<string, FactValue>): AppProfile["capabilities"] {
  return Object.entries(facts)
    .filter(([key]) => key.startsWith("capability."))
    .map(([key, value]) => ({
      id: key.slice("capability.".length),
      present: typeof value === "boolean" ? value : "unknown",
    }));
}

function iosUsageRows(signatures: Signatures, usage: Map<string, { value: string; line: number }>): AppProfile["permissions"]["ios"] {
  const keys = unique(Object.values(signatures.capabilities).flatMap((item) => item.iosUsage).concat(["NSUserTrackingUsageDescription"]));
  return keys.map((key) => {
    const entry = usage.get(key);
    return { key, present: Boolean(entry && entry.value.trim()), line: entry?.line ?? null };
  });
}

async function loadSignatures(packDir: string): Promise<Signatures> {
  const text = await readFile(join(packDir, "signatures.yaml"), "utf8");
  const parsed = signaturesSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new Error(`signatures.yaml is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

function parseYaml(text: string): unknown {
  try {
    return parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function isFlutter(pubspec: unknown, lock: unknown): boolean {
  if (pubspec && typeof pubspec === "object" && "dependencies" in pubspec) {
    const deps = pubspec.dependencies;
    if (deps && typeof deps === "object" && !Array.isArray(deps) && "flutter" in deps) return true;
  }
  if (lock && typeof lock === "object" && "sdks" in lock) {
    const sdks = lock.sdks;
    if (sdks && typeof sdks === "object" && !Array.isArray(sdks) && "flutter" in sdks) return true;
  }
  return false;
}

function collectPackages(pubspecText: string | null, pubspec: unknown, lockText: string | null, lock: unknown): PackageHit[] {
  const hits = new Map<string, PackageHit>();
  if (pubspec && typeof pubspec === "object" && "dependencies" in pubspec && pubspec.dependencies && typeof pubspec.dependencies === "object" && !Array.isArray(pubspec.dependencies)) {
    for (const [name, spec] of Object.entries(pubspec.dependencies)) {
      if (!/^[A-Za-z0-9_]+$/.test(name) || name === "flutter") continue;
      hits.set(name, {
        name,
        spec: typeof spec === "string" ? spec : null,
        path: "pubspec.yaml",
        line: pubspecText ? keyLine(pubspecText, name) : null,
      });
    }
  }
  if (lock && typeof lock === "object" && "packages" in lock && lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages)) {
    for (const [name, spec] of Object.entries(lock.packages)) {
      if (!/^[A-Za-z0-9_]+$/.test(name) || hits.has(name)) continue;
      const version = spec && typeof spec === "object" && "version" in spec && typeof spec.version === "string" ? spec.version : null;
      hits.set(name, {
        name,
        spec: version,
        path: "pubspec.lock",
        line: lockText ? keyLine(lockText, name) : null,
      });
    }
  }
  return [...hits.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function keyLine(text: string, name: string): number | null {
  const match = text.match(new RegExp(`^\\s{2}${name}:`, "m"));
  if (!match || match.index === undefined) return null;
  return lineAt(text, match.index);
}

function assignUsage(
  facts: Record<string, FactValue>,
  bag: EvidenceBag,
  ios: boolean,
  plist: { entries: Map<string, { value: string; line: number }> } | null,
  signatures: Signatures,
): void {
  const usageFacts: Record<string, string> = {
    camera: "ios.usage.camera",
    photos: "ios.usage.photos",
    location: "ios.usage.location",
    microphone: "ios.usage.microphone",
    contacts: "ios.usage.contacts",
    tracking: "ios.usage.tracking",
  };
  const groups: Array<{ fact: string; keys: string[] }> = Object.entries(signatures.capabilities)
    .filter(([id, spec]) => usageFacts[id] !== undefined && spec.iosUsage.length > 0)
    .map(([id, spec]) => ({ fact: usageFacts[id] ?? "", keys: spec.iosUsage }));
  for (const group of groups) {
    if (!ios) {
      facts[group.fact] = "not-applicable";
      continue;
    }
    if (!plist) {
      facts[group.fact] = "unknown";
      continue;
    }
    const found = group.keys.map((key) => ({ key, entry: plist.entries.get(key) })).find((item) => item.entry && item.entry.value.trim());
    facts[group.fact] = Boolean(found);
    if (found?.entry) {
      bag.add(fileEv([group.fact], `${found.key} is set.`, "ios/Runner/Info.plist", found.entry.line, found.entry.value));
    } else {
      bag.add({
        facts: [group.fact],
        kind: "absence",
        detail: `${group.keys.join(" or ")} was not found in Info.plist.`,
        path: "ios/Runner/Info.plist",
      });
    }
  }
}

async function assignDeploymentTarget(facts: Record<string, FactValue>, bag: EvidenceBag, root: string, ios: boolean, unknowns: string[]): Promise<void> {
  if (!ios) {
    facts["ios.deployment_target"] = "unknown";
    return;
  }
  const found: number[] = [];
  const podfile = await readText(join(root, "ios", "Podfile"), 200_000);
  if (podfile) {
    for (const match of podfile.matchAll(/platform\s*:ios\s*,\s*['"](\d+(?:\.\d+)?)['"]/g)) {
      const value = Number(match[1]);
      if (!Number.isNaN(value)) found.push(value);
    }
  }
  const pbx = await readText(join(root, "ios", "Runner.xcodeproj", "project.pbxproj"), 2_000_000);
  if (pbx) {
    for (const match of pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*(\d+(?:\.\d+)?)\s*;/g)) {
      const value = Number(match[1]);
      if (!Number.isNaN(value)) found.push(value);
    }
  }
  const framework = await readPlist(join(root, "ios", "Flutter", "AppFrameworkInfo.plist"));
  const minimum = framework?.entries.get("MinimumOSVersion")?.value;
  if (minimum) {
    const value = Number(minimum);
    if (!Number.isNaN(value)) found.push(value);
  }
  if (found.length === 0) {
    facts["ios.deployment_target"] = "unknown";
    unknowns.push("No iOS deployment target was found in the Podfile, Xcode project, or AppFrameworkInfo.plist.");
    return;
  }
  const lowest = Math.min(...found);
  facts["ios.deployment_target"] = lowest;
  bag.add(fileEv(["ios.deployment_target"], `Lowest iOS deployment target found is ${lowest}.`, "ios", null, found.map(String).join(", ")));
}

async function assignPrivacyManifests(facts: Record<string, FactValue>, bag: EvidenceBag, root: string, ios: boolean): Promise<void> {
  if (!ios) {
    facts["ios.privacy_manifest.present"] = "not-applicable";
    facts["ios.privacy_manifest.incomplete_reasons"] = "not-applicable";
    return;
  }
  const files = await collectFiles(join(root, "ios"), 30, (name) => name === "PrivacyInfo.xcprivacy", new Set(["Pods", ".symlinks", "build"]));
  if (files.length === 0) {
    facts["ios.privacy_manifest.present"] = false;
    facts["ios.privacy_manifest.incomplete_reasons"] = "unknown";
    bag.add({
      facts: ["ios.privacy_manifest.present"],
      kind: "absence",
      detail: "No PrivacyInfo.xcprivacy was found under ios/, excluding Pods.",
      path: "ios",
    });
    return;
  }
  facts["ios.privacy_manifest.present"] = true;
  let incomplete = false;
  for (const file of files) {
    const text = await readText(file, 500_000);
    if (text === null) continue;
    if (manifestReasonsIncomplete(text)) incomplete = true;
    bag.add(fileEv(["ios.privacy_manifest.present"], "Privacy manifest found.", rel(root, file), null, "PrivacyInfo.xcprivacy"));
  }
  facts["ios.privacy_manifest.incomplete_reasons"] = incomplete;
  if (incomplete) {
    bag.add({
      facts: ["ios.privacy_manifest.incomplete_reasons"],
      kind: "file",
      detail: "A privacy manifest lists a required-reason API without a reason code.",
      path: rel(root, files[0] ?? "ios"),
    });
  }
}

function manifestReasonsIncomplete(text: string): boolean {
  if (!text.includes("<key>NSPrivacyAccessedAPIType</key>")) return false;
  const parts = text.split("<key>NSPrivacyAccessedAPIType</key>").slice(1);
  for (const part of parts) {
    const window = part.slice(0, 1200);
    const reasonsAt = window.indexOf("<key>NSPrivacyAccessedAPITypeReasons</key>");
    if (reasonsAt < 0) return true;
    if (!/<string>\s*[^<\s][^<]*<\/string>/.test(window.slice(reasonsAt))) return true;
  }
  return false;
}

interface GradleRead {
  found: boolean;
  path: string | null;
  targetSdk: number | null;
  minSdk: number | null;
  compileSdk: number | null;
  applicationId: string | null;
  targetLine: number | null;
  conflict: boolean;
}

async function readGradle(root: string): Promise<GradleRead> {
  const paths = ["android/app/build.gradle", "android/app/build.gradle.kts"];
  for (const relativePath of paths) {
    const text = await readText(join(root, relativePath), 1_000_000);
    if (text === null) continue;
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const targets = numbers(stripped, [/targetSdk(?:Version)?\s*=\s*(\d+)/g, /targetSdkVersion\s+(\d+)/g]);
    const uniqueTargets = [...new Set(targets)];
    const targetLine = (() => {
      const match = stripped.match(/targetSdk(?:Version)?\s*=\s*(\d+)|targetSdkVersion\s+(\d+)/);
      return match?.index === undefined ? null : lineAt(stripped, match.index);
    })();
    return {
      found: true,
      path: relativePath,
      targetSdk: uniqueTargets.length === 1 ? uniqueTargets[0] ?? null : null,
      minSdk: only(numbers(stripped, [/minSdk(?:Version)?\s*=\s*(\d+)/g, /minSdkVersion\s+(\d+)/g])),
      compileSdk: only(numbers(stripped, [/compileSdk(?:Version)?\s*=\s*(\d+)/g, /compileSdkVersion\s+(\d+)/g])),
      applicationId: stripped.match(/applicationId\s*(?:=)?\s*["']([^"']+)["']/)?.[1] ?? null,
      targetLine,
      conflict: uniqueTargets.length > 1,
    };
  }
  return { found: false, path: null, targetSdk: null, minSdk: null, compileSdk: null, applicationId: null, targetLine: null, conflict: false };
}

function numbers(text: string, patterns: RegExp[]): number[] {
  const found: number[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const value = Number(raw);
      if (Number.isInteger(value)) found.push(value);
    }
  }
  return found;
}

function only(values: number[]): number | null {
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1 ? uniqueValues[0] ?? null : null;
}

function readAndroidPermissions(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/<uses-permission(?:-sdk-\d+)?\b[^>]*android:name\s*=\s*"([^"]+)"[^>]*\/?>/g)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return unique(names);
}

function readXmlAttr(text: string, attr: string): string | null {
  return text.match(new RegExp(`<manifest\\b[^>]*\\b${attr}\\s*=\\s*"([^"]+)"`))?.[1] ?? null;
}

function collectUrls(
  text: string,
  signatures: Signatures,
  path: string,
  urls: { privacy: string[]; support: string[]; accountDeletion: string[] },
  bag: EvidenceBag,
): void {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const match of line.matchAll(/https?:\/\/[^\s'"`<>)\]]+/g)) {
      const url = trimUrl(match[0] ?? "");
      if (!url) continue;
      const kind = classifyUrl(lower, signatures);
      if (!kind) continue;
      urls[kind].push(url);
      const fact = kind === "accountDeletion" ? "urls.account_deletion.in_app" : kind === "privacy" ? "urls.privacy.in_app" : "urls.support.in_app";
      bag.add(fileEv([fact], `In-app ${kind} URL.`, path, index + 1, line));
    }
  });
}

function collectAndroidStrings(
  text: string,
  signatures: Signatures,
  urls: { privacy: string[]; support: string[]; accountDeletion: string[] },
  bag: EvidenceBag,
): void {
  for (const match of text.matchAll(/<string\s+name="([^"]+)"[^>]*>\s*([^<]*https?:\/\/[^<]*)\s*<\/string>/g)) {
    const name = (match[1] ?? "").toLowerCase();
    const url = trimUrl((match[2] ?? "").match(/https?:\/\/[^\s<]+/)?.[0] ?? "");
    if (!url) continue;
    const kind = classifyUrl(name, signatures);
    if (!url || !kind) continue;
    urls[kind].push(url);
    const fact = kind === "accountDeletion" ? "urls.account_deletion.in_app" : kind === "privacy" ? "urls.privacy.in_app" : "urls.support.in_app";
    bag.add(fileEv([fact], `Android string ${match[1] ?? ""} holds a ${kind} URL.`, "android/app/src/main/res/values/strings.xml", null, url));
  }
}

function classifyUrl(context: string, signatures: Signatures): "privacy" | "support" | "accountDeletion" | null {
  const lower = context.toLowerCase();
  if (signatures.urlNeedles.accountDeletion.some((needle) => lower.includes(needle.toLowerCase()))) return "accountDeletion";
  if (signatures.urlNeedles.privacy.some((needle) => lower.includes(needle.toLowerCase()))) return "privacy";
  if (signatures.urlNeedles.support.some((needle) => lower.includes(needle.toLowerCase()))) return "support";
  return null;
}

function applyConfig(facts: Record<string, FactValue>, bag: EvidenceBag, config: ProjectConfig | null): void {
  const yesNo = (value: boolean | undefined): FactValue => value === undefined ? "unknown" : value ? "yes" : "no";
  facts["audience.kids"] = yesNo(config?.audience?.kids);
  facts["audience.health"] = yesNo(config?.audience?.health);
  facts["audience.ugc"] = yesNo(config?.audience?.userGeneratedContent);
  facts["kvkk.explicit_consent"] = yesNo(config?.kvkk?.explicitConsent);
  facts["kvkk.consent_separate"] = yesNo(config?.kvkk?.consentSeparate);
  facts["attestation.apple.xcode_sdk"] = yesNo(config?.attestations?.["apple.xcode-sdk"]);
  facts["attestation.apple.age_rating"] = yesNo(config?.attestations?.["apple.age-rating"]);
  facts["attestation.apple.login_exception"] = yesNo(config?.attestations?.["apple.login-exception"]);
  facts["attestation.apple.att_not_required"] = yesNo(config?.attestations?.["apple.att-not-required"]);
  facts["attestation.apple.subscription_terms"] = yesNo(config?.attestations?.["apple.subscription-terms"]);
  facts["attestation.apple.listed_sdk_manifests"] = yesNo(config?.attestations?.["apple.listed-sdk-manifests"]);
  facts["attestation.google.data_safety"] = yesNo(config?.attestations?.["google.data-safety-form"]);
  facts["google.account"] = config?.google?.account ?? "unknown";
  facts["google.distribution"] = config?.google?.distribution ?? "unknown";
  facts["google.closed_test"] = yesNo(config?.google?.closedTest);
  if (config) {
    bag.add({
      facts: ["audience.kids", "attestation.apple.xcode_sdk", "attestation.google.data_safety", "google.account"],
      kind: "attestation",
      detail: "Answers and attestations were read from .launchymind/project.yaml. They are the developer's statements, not store console proof.",
      path: ".launchymind/project.yaml",
    });
  }
}

function applyUrls(
  facts: Record<string, FactValue>,
  bag: EvidenceBag,
  inApp: { privacy: string[]; support: string[]; accountDeletion: string[] },
  config: ProjectConfig | null,
): void {
  const privacyInApp = inApp.privacy.length > 0;
  const supportInApp = inApp.support.length > 0;
  const deletionInApp = inApp.accountDeletion.length > 0;
  facts["urls.privacy.in_app"] = privacyInApp;
  facts["urls.support.in_app"] = supportInApp;
  facts["urls.account_deletion.in_app"] = deletionInApp;
  facts["urls.privacy.declared"] = Boolean(config?.urls?.privacy);
  facts["urls.support.present"] = supportInApp || Boolean(config?.urls?.support);
  facts["urls.privacy.present"] = privacyInApp || Boolean(config?.urls?.privacy);
  facts["urls.account_deletion.present"] = deletionInApp || Boolean(config?.urls?.accountDeletion);
  facts["urls.developer_website.present"] = Boolean(config?.urls?.developerWebsite);
  if (config?.urls?.privacy) bag.add(fileEv(["urls.privacy.declared"], "Privacy URL declared for store metadata.", ".launchymind/project.yaml", null, config.urls.privacy));
  if (config?.urls?.developerWebsite) bag.add(fileEv(["urls.developer_website.present"], "Developer website declared.", ".launchymind/project.yaml", null, config.urls.developerWebsite));
}

async function readPlist(path: string): Promise<{ entries: Map<string, { value: string; line: number }> } | null> {
  const text = await readText(path, 1_000_000);
  if (!text || !text.includes("<plist")) return null;
  const entries = new Map<string, { value: string; line: number }>();
  for (const match of text.matchAll(/<key>([^<]+)<\/key>\s*<(string|true|false|integer)(?:\s*\/>|>([^<]*)<\/\2>)/g)) {
    const key = match[1];
    if (!key) continue;
    const kind = match[2];
    const value = kind === "true" ? "true" : kind === "false" ? "false" : match[3] ?? "";
    entries.set(key, { value, line: lineAt(text, match.index ?? 0) });
  }
  return { entries };
}

async function collectFiles(root: string, limit: number, accept: (name: string) => boolean, skipped = new Set<string>()): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files, limit, accept, skipped);
  return files;
}

async function walk(dir: string, files: string[], limit: number, accept: (name: string) => boolean, skipped: Set<string>): Promise<void> {
  if (files.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= limit) return;
    if (entry.name.startsWith(".") || skipped.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files, limit, accept, skipped);
    else if (entry.isFile() && accept(entry.name)) files.push(full);
  }
}

async function readText(path: string, max: number): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) return null;
    return (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function fileEv(facts: string[], detail: string, path: string, line: number | null, snippet: string | null): Omit<Evidence, "id"> {
  return {
    facts,
    kind: "file",
    detail,
    path,
    ...(line === null ? {} : { line }),
    ...(snippet === null ? {} : { snippet: redact(snippet) }),
  };
}

function redact(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 180);
  if (/api[_-]?key|secret|password|token/i.test(trimmed)) return "[redacted]";
  return trimmed;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

function trimUrl(raw: string): string {
  return raw.replace(/[.,;]+$/, "");
}

function rel(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}
