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
import { draftLabels, loadSdkBase, sdkFacts } from "../../labels/src/index.ts";
import { readStore } from "../../store/src/index.ts";

const capabilitySchema = z.object({
  packages: z.array(z.string().min(1)).min(1),
  npm: z.array(z.string().min(1)).min(1).optional(),
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

export const projectSchema = z.object({
  appName: z.string().min(1).max(200).optional(),
  developerName: z.string().min(1).max(200).optional(),
  audience: z.object({
    kids: z.boolean().optional(),
    health: z.boolean().optional(),
    userGeneratedContent: z.boolean().optional(),
  }).strict().optional(),
  regions: z.array(z.enum(["TR", "EU", "EEA", "US"])).optional(),
  packs: z.object({
    kvkk: z.boolean().optional(),
    gdpr: z.boolean().optional(),
    coppa: z.boolean().optional(),
    appleKids: z.boolean().optional(),
    googleFamilies: z.boolean().optional(),
    dsa: z.boolean().optional(),
    accessibility: z.boolean().optional(),
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
    "google.data-safety-ad-id": z.boolean().optional(),
    "coppa.notice": z.boolean().optional(),
    "eu.dsa-trader": z.boolean().optional(),
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
  storeUrls: string[];
  legalPackIds: string[];
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

export async function scanProject(projectPath: string, packDir: string, now = new Date()): Promise<ScanResult> {
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
  const packageJsonText = await readText(join(projectPath, "package.json"), 1_000_000);
  const packageJson = parseJson(packageJsonText);
  const npmPackages = collectNpmPackages(packageJsonText, packageJson);
  for (const item of npmPackages) {
    if (!packages.some((existing) => existing.name === item.name)) packages.push(item);
  }
  const expo = await detectExpo(projectPath, npmPackages);
  const reactNative = expo || npmPackages.some((item) => item.name === "react-native");
  const flutter = isFlutter(pubspec, lock);
  facts["framework.flutter"] = flutter;
  facts["framework.react_native"] = reactNative;
  facts["framework.expo"] = expo;
  if (!flutter && !reactNative) unknowns.push("This folder does not look like a Flutter, React Native, or Expo project.");

  const ios = await isDir(join(projectPath, "ios"));
  const android = await isDir(join(projectPath, "android"));
  facts["platform.ios"] = ios;
  facts["platform.android"] = android;

  const dartFiles = await collectFiles(join(projectPath, "lib"), 200, (name) => name.endsWith(".dart"));
  const dartScanned = await isDir(join(projectPath, "lib"));
  const scriptFiles = reactNative && !flutter
    ? await collectFiles(projectPath, 200, (name) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(name), new Set(["node_modules", "ios", "android", "Pods", "build", "dist", "coverage", "web"]))
    : [];
  const codeScanned = dartScanned || scriptFiles.length > 0 || (reactNative && !flutter);
  const imported = new Set<string>();
  let deletion = false;
  let subscription = false;
  let price = false;
  let umpRequested = false;
  let sampleUnguarded = false;
  const dartTexts: string[] = [];
  const inAppUrls = { privacy: [] as string[], support: [] as string[], accountDeletion: [] as string[] };

  for (const file of [...dartFiles, ...scriptFiles]) {
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
    if (/requestconsentinfoupdate|consentinformation|usermessagingplatform/i.test(text)) umpRequested = true;
    if (file.endsWith(".dart")) dartTexts.push(text);
    if (unguardedSampleIds(text).length > 0) {
      sampleUnguarded = true;
      bag.add(fileEv(["ads.sample_unit_in_shipped_config"], "Google's sample AdMob publisher id is reachable in a release build.", display, lineOfNeedle(text, GOOGLE_SAMPLE_AD_PUBLISHER), GOOGLE_SAMPLE_AD_PUBLISHER));
    }
    collectUrls(text, signatures, display, inAppUrls, bag);
  }

  const knownPackages = new Set<string>([...packages.map((item) => item.name), ...imported]);
  for (const name of imported) {
    if (!packages.some((item) => item.name === name)) {
      packages.push({ name, spec: null, path: "lib", line: null });
    }
  }

  const plistPath = ios ? await findIosPlist(projectPath) : null;
  const plistRel = plistPath ? rel(projectPath, plistPath) : "ios/Runner/Info.plist";
  const plist = plistPath ? await readPlist(plistPath) : null;
  if (ios && !plist) unknowns.push(`${plistRel} was missing or could not be read.`);
  const usage = new Map<string, { value: string; line: number }>();
  if (plist) {
    for (const [key, value] of plist.entries) usage.set(key, value);
  }

  for (const [id, spec] of Object.entries(signatures.capabilities)) {
    const npmNames = spec.npm ?? [];
    const used = spec.packages.some((name) => knownPackages.has(name)) || npmNames.some((name) => knownPackages.has(name));
    const declared = spec.iosUsage.some((key) => {
      const entry = usage.get(key);
      return Boolean(entry && entry.value.trim());
    });
    facts[`capability.${id}`] = used || declared;
    if (used) {
      const hit = packages.find((item) => spec.packages.includes(item.name) || npmNames.includes(item.name));
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
  const bundled = await loadBundledManifests(packDir);
  const coverage = listed.length === 0 ? null : bundledManifestCoverage(listed, packages, bundled);
  facts["listed_sdk.bundled_manifests"] = coverage?.status ?? "not-applicable";
  for (const detail of coverage?.details ?? []) {
    bag.add({
      facts: ["listed_sdk.bundled_manifests"],
      kind: "dependency",
      detail,
      path: "pubspec.lock",
    });
  }
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

  const packageKnown = Boolean(packageJson && typeof packageJson === "object");
  if (!pubspecKnown && !packageKnown) {
    for (const id of Object.keys(signatures.capabilities)) facts[`capability.${id}`] = "unknown";
    facts["capability.listed_sdk"] = "unknown";
    facts["capability.third_party_login"] = "unknown";
    facts["capability.non_apple_third_party_login"] = "unknown";
    facts["capability.apple_sign_in"] = "unknown";
    facts["ads.google"] = "unknown";
  }

  const ignored = new Set(signatures.ignoredPackages);
  const recognized = new Set<string>([
    ...Object.values(signatures.capabilities).flatMap((item) => [...item.packages, ...(item.npm ?? [])]),
    ...signatures.listedSdks.map((item) => item.pub),
    ...signatures.thirdPartyLogin,
    ...signatures.appleSignIn,
    ...signatures.googleAds,
  ]);
  for (const item of packages) {
    if (item.path !== "pubspec.yaml" && item.path !== "package.json") continue;
    if (ignored.has(item.name) || recognized.has(item.name) || item.name === "flutter" || FRAMEWORK_NPM.has(item.name)) continue;
    observations.push({
      id: `package.unrecognized.${item.name}`,
      detail: `Package ${item.name} is not in the core capability map. It did not select extra rules. Add it to a pack if it implies a store or privacy duty.`,
      path: item.path,
      ...(item.line === null ? {} : { line: item.line }),
    });
  }

  assignUsage(facts, bag, ios, plist, plistRel, signatures);
  await assignDeploymentTarget(facts, bag, projectPath, ios, unknowns);
  await assignPrivacyManifests(facts, bag, projectPath, ios);
  const entitlements = ios ? await collectFiles(join(projectPath, "ios"), 20, (name) => name.endsWith(".entitlements"), new Set(["Pods", ".symlinks", "build"])) : [];
  for (const file of entitlements) {
    const text = await readText(file, 200_000);
    if (text?.includes("com.apple.developer.applesignin")) {
      facts["capability.apple_sign_in"] = true;
      bag.add(fileEv(["capability.apple_sign_in"], "Entitlements include Sign in with Apple.", rel(projectPath, file), null, "com.apple.developer.applesignin"));
    }
    if (text?.includes("com.apple.developer.game-center")) {
      facts["capability.game_center"] = true;
      bag.add(fileEv(["capability.game_center"], "Entitlements include Game Center.", rel(projectPath, file), null, "com.apple.developer.game-center"));
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
  const flutterSdk = readFlutterSdkPin(lockText, await readText(join(projectPath, ".fvmrc"), 20_000), await readText(join(projectPath, ".fvm/fvm_config.json"), 20_000));
  const sdkDefaults = await flutterSdkDefaults(packDir, flutterSdk);
  const useFlutterTarget = gradle.targetSdk === null && gradle.usesFlutterTarget && sdkDefaults !== null;
  const useFlutterMin = gradle.minSdk === null && gradle.usesFlutterMin && sdkDefaults !== null;
  facts["android.target_sdk"] = gradle.targetSdk ?? (useFlutterTarget ? sdkDefaults.targetSdk : "unknown");
  facts["android.min_sdk"] = gradle.minSdk ?? (useFlutterMin ? sdkDefaults.minSdk : "unknown");
  facts["android.compile_sdk"] = gradle.compileSdk ?? "unknown";
  facts["android.target_sdk_basis"] = gradle.targetSdk !== null
    ? "gradle"
    : useFlutterTarget ? sdkDefaults.basis : "unknown";
  if (gradle.targetSdk !== null) {
    bag.add(fileEv(["android.target_sdk", "android.target_sdk_basis"], `targetSdk ${gradle.targetSdk} is written in Gradle.`, gradle.path ?? "android/app/build.gradle", gradle.targetLine, String(gradle.targetSdk)));
  } else if (useFlutterTarget) {
    bag.add(fileEv(
      ["android.target_sdk", "android.target_sdk_basis"],
      `No numeric targetSdk in Gradle. flutter.targetSdkVersion is filled from LaunchyMind's Flutter SDK default table: Flutter ${sdkDefaults.version} defaults to targetSdk ${sdkDefaults.targetSdk} (${sdkDefaults.basis === "flutter-sdk-exact" ? "exact pin" : "minimum constraint in pubspec.lock, so a newer SDK may be higher"}). Source: ${sdkDefaults.source}`,
      sdkDefaults.basis === "flutter-sdk-exact" ? ".fvmrc" : "pubspec.lock",
      null,
      `flutter ${sdkDefaults.version} → targetSdk ${sdkDefaults.targetSdk}`,
    ));
  }
  if (gradle.conflict) unknowns.push("Gradle targetSdk values disagree. The target API was left unknown instead of picking one.");

  const sampleInPlist = plist ? [...plist.entries.values()].some((entry) => entry.value.includes(GOOGLE_SAMPLE_AD_PUBLISHER)) : false;
  const sampleInManifest = manifestText?.includes(GOOGLE_SAMPLE_AD_PUBLISHER) ?? false;
  const sampleShipped = sampleInPlist || sampleInManifest || sampleUnguarded;
  if (facts["capability.ads"] === true) {
    facts["ads.sample_unit_in_shipped_config"] = sampleShipped;
    facts["ads.ump_requested"] = codeScanned ? umpRequested : "unknown";
    if (sampleShipped) {
      bag.add({
        facts: ["ads.sample_unit_in_shipped_config"],
        kind: sampleInPlist || sampleInManifest ? "file" : "scan",
        detail: "Google's sample AdMob publisher id ca-app-pub-3940256099942544 is in a file that ships, or in Dart without a clear debug-only guard and a separate real id.",
        ...(sampleInPlist ? { path: plistRel } : sampleInManifest ? { path: "android/app/src/main/AndroidManifest.xml" } : { path: "lib" }),
      });
    }
  } else if (facts["capability.ads"] === false) {
    facts["ads.sample_unit_in_shipped_config"] = "not-applicable";
    facts["ads.ump_requested"] = "not-applicable";
  }
  const stubState = !dartScanned ? "unknown" : stubPurchaseState(dartTexts, facts["capability.payments"] === true);
  facts["payments.stub_ui"] = stubState;
  if (stubState === "reachable") {
    bag.add({
      facts: ["payments.stub_ui"],
      kind: "scan",
      detail: "Stub purchase or restore-purchase text is reachable and no purchase SDK from the capability map is present.",
      path: "lib",
    });
  } else if (stubState === "gated") {
    observations.push({
      id: "payments.stub-gated",
      detail: "Stub purchase text is present, but only inside a branch of a const false flag, so it is not reachable in this build.",
      path: "lib",
    });
  }

  facts["android.ad_id"] = await androidAdIdFact(projectPath, manifestText, knownPackages, facts["capability.ads"] === true, facts["platform.android"] === true);
  if (facts["android.ad_id"] === "merged-by-sdk") {
    bag.add({
      facts: ["android.ad_id"],
      kind: "dependency",
      detail: "google_mobile_ads depends on com.google.android.gms:play-services-ads. Android merges an AD_ID permission declared by that SDK unless the app manifest removes it. The AAR was not opened.",
      path: "pubspec.yaml",
    });
  }

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
  else if (!codeScanned) facts["account.deletion.in_app"] = "unknown";
  else facts["account.deletion.in_app"] = deletion || inAppUrls.accountDeletion.length > 0;
  if (accounts && codeScanned && facts["account.deletion.in_app"] === false) {
    bag.add({
      facts: ["account.deletion.in_app"],
      kind: "absence",
      detail: dartScanned
        ? "lib/ was scanned and no account-deletion symbol, phrase, or in-app deletion URL was found."
        : "Source files were scanned and no account-deletion phrase or in-app deletion URL was found.",
      path: dartScanned ? "lib" : "package.json",
    });
  }

  if (facts["capability.payments"] !== true) facts["payments.subscription_terms_found"] = facts["capability.payments"] === false ? "not-applicable" : "unknown";
  else if (!codeScanned) facts["payments.subscription_terms_found"] = "unknown";
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
  if (flutter) {
    limitations.push({
      id: "dart-surface-scan",
      detail: "Dart is scanned for imports and selected phrases. It is not type-checked and it is not executed.",
      blocksReady: false,
    });
  }
  if (reactNative && !flutter) {
    limitations.push({
      id: "javascript-surface-scan",
      detail: "JavaScript and TypeScript are scanned for imports and selected phrases. They are not executed, and Expo config plugins are not run. Facts the source does not show stay unknown.",
      blocksReady: false,
    });
  }

  const family = await detectDeviceFamily(projectPath, plistPath);
  facts["ios.device_family"] = ios ? family : "not-applicable";
  facts["connect.apple"] = "off";
  facts["connect.google"] = "off";
  facts["artifact.present"] = false;
  facts["artifact.drift"] = "not-applicable";
  const sdkDraft = draftLabels(packages.map((item) => item.name), await loadSdkBase());
  Object.assign(facts, sdkFacts(sdkDraft, facts));
  if (sdkDraft.apple.items.length || sdkDraft.unknownSdks.length) {
    bag.add({
      facts: ["sdk.coverage", "sdk.manifest_mismatch", "sdk.answer_mismatch"],
      kind: "dependency",
      detail: `Verified SDK draft rows: ${sdkDraft.apple.items.length + sdkDraft.play.items.length}. Unknown SDKs: ${sdkDraft.unknownSdks.map((item) => item.id).join(", ") || "none"}.`,
      path: "pubspec.yaml",
    });
  }
  const store = await readStore(projectPath, now, family);
  for (const [key, value] of Object.entries(store.facts)) facts[key] = value;
  for (const item of store.evidence) bag.add(item);

  const appJsonName = await expoDisplayName(projectPath);
  const displayName = config?.appName ?? appJsonName ?? plist?.entries.get("CFBundleDisplayName")?.value ?? plist?.entries.get("CFBundleName")?.value ?? null;
  const name = stringField(pubspec, "name") ?? stringField(packageJson, "name");
  const version = stringField(pubspec, "version") ?? stringField(packageJson, "version");
  const profile: AppProfile = {
    framework: flutter ? "flutter" : expo ? "expo" : reactNative ? "react-native" : "unknown",
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
    storeUrls: store.urls,
    legalPackIds: [...enabledLegalPacks(config)],
  };
}

export function enabledLegalPacks(config: ProjectConfig | null): Set<string> {
  const regions = new Set(config?.regions ?? []);
  const kids = config?.audience?.kids === true;
  const packs = config?.packs;
  const enabled = new Set<string>();
  const allow = (flag: boolean | undefined, inferred: boolean) => flag === true || (flag !== false && inferred);
  if (allow(packs?.kvkk, regions.has("TR"))) enabled.add("kvkk");
  if (allow(packs?.gdpr, regions.has("EU") || regions.has("EEA"))) enabled.add("gdpr");
  if (allow(packs?.coppa, kids && regions.has("US"))) enabled.add("coppa");
  if (allow(packs?.appleKids, kids)) enabled.add("apple-kids");
  if (allow(packs?.googleFamilies, kids)) enabled.add("google-families");
  if (allow(packs?.dsa, regions.has("EU") || regions.has("EEA"))) enabled.add("dsa");
  if (packs?.accessibility === true) enabled.add("accessibility");
  return enabled;
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

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function collectNpmPackages(text: string | null, doc: unknown): PackageHit[] {
  const record = asRecord(doc);
  const deps = { ...asRecord(record.dependencies), ...asRecord(record.optionalDependencies) };
  const hits: PackageHit[] = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) continue;
    hits.push({
      name,
      spec: typeof spec === "string" ? spec : null,
      path: "package.json",
      line: text ? jsonKeyLine(text, name) : null,
    });
  }
  return hits.sort((a, b) => a.name.localeCompare(b.name));
}

function jsonKeyLine(text: string, name: string): number | null {
  const match = text.match(new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`));
  if (!match || match.index === undefined) return null;
  return lineAt(text, match.index);
}

const FRAMEWORK_NPM = new Set(["react", "react-native", "expo", "expo-status-bar", "react-dom"]);

async function detectExpo(root: string, npm: PackageHit[]): Promise<boolean> {
  if (npm.some((item) => item.name === "expo")) return true;
  const appJson = await readText(join(root, "app.json"), 1_000_000);
  const parsed = parseJson(appJson);
  return Boolean(parsed && typeof parsed === "object" && "expo" in parsed);
}

async function expoDisplayName(root: string): Promise<string | null> {
  const parsed = parseJson(await readText(join(root, "app.json"), 1_000_000));
  if (!parsed || typeof parsed !== "object" || !("expo" in parsed)) return null;
  const expo = (parsed as { expo?: unknown }).expo;
  return expo && typeof expo === "object" && "name" in expo && typeof expo.name === "string" ? expo.name : null;
}

export async function detectDeviceFamily(root: string, plistPath: string | null): Promise<"iphone" | "ipad" | "universal" | "unknown"> {
  const signals = new Set<"iphone" | "ipad">();
  const plistText = plistPath ? await readText(plistPath, 1_000_000) : null;
  const families = plistText?.match(/<key>\s*UIDeviceFamily\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i)?.[1] ?? "";
  if (families.includes(">1<")) signals.add("iphone");
  if (families.includes(">2<")) signals.add("ipad");
  const projects = await collectFiles(join(root, "ios"), 20, (name) => name === "project.pbxproj", new Set(["Pods", "build"]));
  for (const project of projects) {
    const text = await readText(project, 2_000_000);
    const match = text?.match(/TARGETED_DEVICE_FAMILY\s*=\s*"?([12](?:\s*,\s*[12])?)"?/);
    const value = match?.[1]?.replace(/\s/g, "") ?? "";
    if (value.includes("1")) signals.add("iphone");
    if (value.includes("2")) signals.add("ipad");
  }
  if (signals.size === 0) {
    const appJson = await readText(join(root, "app.json"), 1_000_000);
    if (appJson?.includes("\"supportsTablet\": true") || appJson?.includes("\"supportsTablet\":true")) return "universal";
    if (appJson?.includes("\"supportsTablet\": false") || appJson?.includes("\"supportsTablet\":false")) return "iphone";
  }
  if (signals.has("iphone") && signals.has("ipad")) return "universal";
  if (signals.has("ipad")) return "ipad";
  if (signals.has("iphone")) return "iphone";
  return "unknown";
}

async function findIosPlist(root: string): Promise<string | null> {
  const runner = join(root, "ios", "Runner", "Info.plist");
  if (await isFile(runner)) return runner;
  const found = await collectFiles(join(root, "ios"), 40, (name) => name === "Info.plist", new Set(["Pods", ".symlinks", "build", "node_modules"]));
  return found[0] ?? null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
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
  plistRel: string,
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
      bag.add(fileEv([group.fact], `${found.key} is set.`, plistRel, found.entry.line, found.entry.value));
    } else {
      bag.add({
        facts: [group.fact],
        kind: "absence",
        detail: `${group.keys.join(" or ")} was not found in Info.plist.`,
        path: plistRel,
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
    facts["ios.privacy_manifest.tracking"] = "not-applicable";
    facts["ios.privacy_manifest.tracking_consistent"] = "not-applicable";
    return;
  }
  const files = await collectFiles(join(root, "ios"), 30, (name) => name === "PrivacyInfo.xcprivacy", new Set(["Pods", ".symlinks", "build"]));
  if (files.length === 0) {
    facts["ios.privacy_manifest.present"] = false;
    facts["ios.privacy_manifest.incomplete_reasons"] = "unknown";
    facts["ios.privacy_manifest.tracking"] = "unknown";
    facts["ios.privacy_manifest.tracking_consistent"] = "unknown";
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
  let tracking: FactValue = "unknown";
  let consistent: FactValue = "yes";
  for (const file of files) {
    const text = await readText(file, 500_000);
    if (text === null) continue;
    if (manifestReasonsIncomplete(text)) incomplete = true;
    const read = readTrackingManifest(text);
    tracking = read.tracking;
    if (read.consistent === "no") consistent = "no";
    bag.add(fileEv(
      ["ios.privacy_manifest.present", "ios.privacy_manifest.tracking", "ios.privacy_manifest.tracking_consistent"],
      `Privacy manifest tracking flag is ${read.tracking}. Collected-data tracking and tracking domains ${read.consistent === "yes" ? "agree with that flag" : "disagree with that flag"}.`,
      rel(root, file),
      null,
      read.snippet,
    ));
  }
  facts["ios.privacy_manifest.incomplete_reasons"] = incomplete;
  facts["ios.privacy_manifest.tracking"] = tracking;
  facts["ios.privacy_manifest.tracking_consistent"] = consistent;
  if (incomplete) {
    bag.add({
      facts: ["ios.privacy_manifest.incomplete_reasons"],
      kind: "file",
      detail: "A privacy manifest lists a required-reason API without a reason code.",
      path: rel(root, files[0] ?? "ios"),
    });
  }
}

function readTrackingManifest(text: string): { tracking: "true" | "false" | "unknown"; consistent: "yes" | "no"; snippet: string } {
  const trackingMatch = text.match(/<key>NSPrivacyTracking<\/key>\s*<(true|false)\s*\/?>/i);
  const tracking = trackingMatch?.[1] === "true" ? "true" : trackingMatch?.[1] === "false" ? "false" : "unknown";
  const domainsBlock = text.match(/<key>NSPrivacyTrackingDomains<\/key>\s*<array>([\s\S]*?)<\/array>/i)?.[1] ?? "";
  const domainsEmpty = domainsBlock.length === 0 ? "unknown" : !/<string>/.test(domainsBlock);
  const collectedTracking = /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\s*\/?>/i.test(text);
  let consistent: "yes" | "no" = "yes";
  if (tracking === "false" && collectedTracking) consistent = "no";
  if (tracking === "true" && domainsEmpty === true) consistent = "no";
  const snippet = tracking === "unknown"
    ? "NSPrivacyTracking was not read"
    : `NSPrivacyTracking=${tracking}; collected tracking=${collectedTracking ? "yes" : "no"}; tracking domains ${domainsEmpty === true ? "empty" : domainsEmpty === false ? "present" : "not read"}`;
  return { tracking, consistent, snippet };
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
  usesFlutterTarget: boolean;
  usesFlutterMin: boolean;
}

async function readGradle(root: string): Promise<GradleRead> {
  const paths = ["android/app/build.gradle", "android/app/build.gradle.kts"];
  for (const relativePath of paths) {
    const text = await readText(join(root, relativePath), 1_000_000);
    if (text === null) continue;
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const usesFlutterTarget = /flutter\.targetSdkVersion\b/.test(stripped) || /flutter\.targetSdk\b/.test(stripped);
    const usesFlutterMin = /flutter\.minSdkVersion\b/.test(stripped);
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
      usesFlutterTarget,
      usesFlutterMin,
    };
  }
  return { found: false, path: null, targetSdk: null, minSdk: null, compileSdk: null, applicationId: null, targetLine: null, conflict: false, usesFlutterTarget: false, usesFlutterMin: false };
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
  facts["attestation.google.data_safety_ad_id"] = yesNo(config?.attestations?.["google.data-safety-ad-id"]);
  facts["attestation.coppa.notice"] = yesNo(config?.attestations?.["coppa.notice"]);
  facts["attestation.eu.dsa_trader"] = yesNo(config?.attestations?.["eu.dsa-trader"]);
  const regions = new Set(config?.regions ?? []);
  facts["region.tr"] = regions.has("TR") ? "yes" : "no";
  facts["region.eu"] = regions.has("EU") || regions.has("EEA") ? "yes" : "no";
  facts["region.us"] = regions.has("US") ? "yes" : "no";
  const enabled = enabledLegalPacks(config);
  facts["legal.pack.kvkk"] = enabled.has("kvkk");
  facts["legal.pack.gdpr"] = enabled.has("gdpr");
  facts["legal.pack.coppa"] = enabled.has("coppa");
  facts["legal.pack.apple_kids"] = enabled.has("apple-kids");
  facts["legal.pack.google_families"] = enabled.has("google-families");
  facts["legal.pack.dsa"] = enabled.has("dsa");
  facts["legal.pack.accessibility"] = enabled.has("accessibility");
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

const GOOGLE_SAMPLE_AD_PUBLISHER = "ca-app-pub-3940256099942544";

function lineOfNeedle(text: string, needle: string): number | null {
  const index = text.indexOf(needle);
  return index < 0 ? null : lineAt(text, index);
}

export function unguardedSampleIds(source: string): number[] {
  const masked = maskDart(source);
  const hits: number[] = [];
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(GOOGLE_SAMPLE_AD_PUBLISHER, from);
    if (at < 0) break;
    if (!sampleUseIsNonRelease(masked, at)) hits.push(at);
    from = at + GOOGLE_SAMPLE_AD_PUBLISHER.length;
  }
  return hits;
}

export function stubPurchaseState(files: readonly string[], hasPurchaseSdk: boolean): "absent" | "gated" | "reachable" | "unknown" {
  if (hasPurchaseSdk) return "absent";
  const flags = new Set<string>();
  const hits: Array<{ masked: string; at: number }> = [];
  for (const file of files) {
    for (const match of file.matchAll(/(?:static\s+)?const\s+([A-Za-z_]\w*)\s*=\s*false\b/g)) {
      if (match[1]) flags.add(match[1]);
    }
    const masked = maskDart(file);
    const lower = file.toLowerCase();
    const needles = ["purchase is stubbed", "stubbed in this build", "restorepurchases", "restore purchases"];
    for (const needle of needles) {
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        hits.push({ masked, at });
        from = at + needle.length;
      }
    }
  }
  if (hits.length === 0) return "absent";
  return hits.every((hit) => guardedByConstFalse(hit.masked, hit.at, flags)) ? "gated" : "reachable";
}

function maskDart(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === "'" || c === "\"") {
      out += c;
      i += 1;
      while (i < source.length) {
        const ch = source[i] ?? "";
        if (ch === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += ch === "\n" ? "\n" : ch === c ? c : " ";
        i += 1;
        if (ch === c) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function sampleUseIsNonRelease(masked: string, index: number): boolean {
  const ternary = enclosingTernary(masked, index);
  if (ternary) return armIsNonRelease(ternary.cond, ternary.arm);
  const branch = enclosingIf(masked, index);
  if (!branch) return false;
  return armIsNonRelease(branch.cond, branch.inElse ? "false" : "true");
}

function guardedByConstFalse(masked: string, index: number, flags: ReadonlySet<string>): boolean {
  const ternary = enclosingTernary(masked, index);
  if (ternary && deadArm(ternary.cond, ternary.arm, flags)) return true;
  const branch = enclosingIf(masked, index);
  if (branch && deadArm(branch.cond, branch.inElse ? "false" : "true", flags)) return true;
  return false;
}

function deadArm(cond: string, arm: "true" | "false", flags: ReadonlySet<string>): boolean {
  const polarity = flagPolarity(cond, flags);
  if (!polarity) return false;
  if (!polarity.negated) return arm === "true";
  return arm === "false";
}

function armIsNonRelease(cond: string, arm: "true" | "false"): boolean {
  const compact = cond.replace(/\s+/g, "");
  const negatedRelease = /!kReleaseMode$/.test(compact);
  const release = !negatedRelease && /(?:^|[^!\w])kReleaseMode$/.test(compact);
  const negatedDebug = /!kDebugMode$/.test(compact);
  const debug = !negatedDebug && /(?:^|[^!\w])kDebugMode$/.test(compact);
  const negatedProfile = /!kProfileMode$/.test(compact);
  const profile = !negatedProfile && /(?:^|[^!\w])kProfileMode$/.test(compact);
  if (release) return arm === "false";
  if (negatedRelease || debug || profile) return arm === "true";
  if (negatedDebug || negatedProfile) return arm === "false";
  return false;
}

function flagPolarity(cond: string, flags: ReadonlySet<string>): { negated: boolean } | null {
  const compact = cond.replace(/\s+/g, "");
  for (const name of flags) {
    if (new RegExp(`!${name}$`).test(compact)) return { negated: true };
    if (compact === name || new RegExp(`[^\\w!]${name}$`).test(compact)) return { negated: false };
  }
  return null;
}

function enclosingTernary(masked: string, index: number): { cond: string; arm: "true" | "false" } | null {
  let paren = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = masked[i];
    if (c === ")") paren += 1;
    else if (c === "(") paren = Math.max(0, paren - 1);
    else if (paren === 0 && (c === ";" || c === "{" || c === "}")) break;
    else if (paren === 0 && c === "?") {
      const colon = matchTernaryColon(masked, i);
      if (colon < 0) continue;
      const cond = masked.slice(Math.max(0, i - 120), i);
      return { cond, arm: index > colon ? "false" : "true" };
    }
  }
  return null;
}

function matchTernaryColon(masked: string, question: number): number {
  let nested = 0;
  let paren = 0;
  for (let i = question + 1; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "(") paren += 1;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (paren === 0 && c === "?") nested += 1;
    else if (paren === 0 && c === ":") {
      if (nested === 0) return i;
      nested -= 1;
    } else if (paren === 0 && (c === ";" || c === "}")) return -1;
  }
  return -1;
}

function enclosingIf(masked: string, index: number): { cond: string; inElse: boolean } | null {
  const frames: Array<{ depth: number; cond: string; inElse: boolean }> = [];
  let depth = 0;
  let i = 0;
  while (i < index) {
    const c = masked[i] ?? "";
    if (c === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      let cursor = i + 1;
      while (masked[cursor] === " " || masked[cursor] === "\n") cursor += 1;
      const followedByElse = masked.startsWith("else", cursor) && !/\w/.test(masked[cursor + 4] ?? "");
      const keepDepth = followedByElse ? depth + 1 : depth;
      while (frames.length > 0 && (frames[frames.length - 1]?.depth ?? 0) > keepDepth) frames.pop();
      i += 1;
      continue;
    }
    if (masked.startsWith("if", i) && !/\w/.test(masked[i + 2] ?? "")) {
      const open = masked.indexOf("(", i);
      if (open < 0 || open > i + 6) {
        i += 1;
        continue;
      }
      const close = matchParen(masked, open);
      if (close < 0) break;
      const cond = masked.slice(open + 1, close);
      let cursor = close + 1;
      while (masked[cursor] === " " || masked[cursor] === "\n") cursor += 1;
      if (masked[cursor] === "{") {
        frames.push({ depth: depth + 1, cond, inElse: false });
      }
      i = cursor;
      continue;
    }
    if (masked.startsWith("else", i) && !/\w/.test(masked[i + 4] ?? "")) {
      let cursor = i + 4;
      while (masked[cursor] === " " || masked[cursor] === "\n") cursor += 1;
      if (masked.startsWith("if", cursor)) {
        i = cursor;
        continue;
      }
      const previous = frames.pop();
      if (previous && masked[cursor] === "{") {
        frames.push({ depth: depth + 1, cond: previous.cond, inElse: true });
      }
      i = cursor;
      continue;
    }
    i += 1;
  }
  const top = frames[frames.length - 1];
  return top ? { cond: top.cond, inElse: top.inElse } : null;
}

function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface FlutterPin {
  version: string;
  exact: boolean;
}

function readFlutterSdkPin(lockText: string | null, fvmrc: string | null, fvmConfig: string | null): FlutterPin | null {
  const exact = semver(fvmrc?.trim() ?? "") ?? semver(jsonFlutter(fvmConfig));
  if (exact) return { version: exact, exact: true };
  if (!lockText) return null;
  const sdkBlock = lockText.match(/(?:^|\n)sdks:\n([\s\S]*)$/)?.[1] ?? "";
  const flutterLine = sdkBlock.match(/^\s*flutter:\s*"([^"]+)"/m)?.[1] ?? "";
  const minimum = flutterLine.match(/(\d+\.\d+\.\d+)/)?.[1];
  return minimum ? { version: minimum, exact: false } : null;
}

function jsonFlutter(text: string | null): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { flutter?: unknown };
    return typeof parsed.flutter === "string" ? parsed.flutter : "";
  } catch {
    return "";
  }
}

function semver(value: string): string | null {
  return value.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

interface SdkDefault {
  version: string;
  targetSdk: number;
  minSdk: number;
  compileSdk: number;
  basis: "flutter-sdk-exact" | "flutter-sdk-minimum";
  source: string;
}

async function flutterSdkDefaults(packDir: string, pin: FlutterPin | null): Promise<SdkDefault | null> {
  if (!pin) return null;
  const text = await readText(join(packDir, "flutter-sdk-defaults.yaml"), 200_000);
  const parsed = text ? parseYaml(text) : null;
  if (!parsed || typeof parsed !== "object" || !("rows" in parsed) || !Array.isArray(parsed.rows)) return null;
  const rows = parsed.rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const version = "flutter" in row && typeof row.flutter === "string" ? row.flutter : null;
    const targetSdk = "targetSdk" in row && typeof row.targetSdk === "number" ? row.targetSdk : null;
    const minSdk = "minSdk" in row && typeof row.minSdk === "number" ? row.minSdk : null;
    const compileSdk = "compileSdk" in row && typeof row.compileSdk === "number" ? row.compileSdk : null;
    const source = "source" in row && typeof row.source === "string" ? row.source : "";
    if (!version || targetSdk === null || minSdk === null || compileSdk === null) return [];
    return [{ version, targetSdk, minSdk, compileSdk, source }];
  }).sort((a, b) => compareSemver(a.version, b.version));
  const eligible = rows.filter((row) => compareSemver(row.version, pin.version) <= 0);
  const chosen = eligible[eligible.length - 1];
  if (!chosen) return null;
  return { ...chosen, basis: pin.exact ? "flutter-sdk-exact" : "flutter-sdk-minimum" };
}

interface BundledManifest {
  pub: string;
  since: string;
  before?: string;
  implementation?: string;
  source: string;
  note?: string;
}

async function loadBundledManifests(packDir: string): Promise<BundledManifest[]> {
  const text = await readText(join(packDir, "bundled-privacy-manifests.yaml"), 200_000);
  const parsed = text ? parseYaml(text) : null;
  if (!parsed || typeof parsed !== "object" || !("plugins" in parsed) || !Array.isArray(parsed.plugins)) return [];
  return parsed.plugins.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const pub = "pub" in row && typeof row.pub === "string" ? row.pub : null;
    const since = "since" in row && typeof row.since === "string" ? row.since : null;
    const source = "source" in row && typeof row.source === "string" ? row.source : "";
    const before = "before" in row && typeof row.before === "string" ? row.before : undefined;
    const implementation = "implementation" in row && typeof row.implementation === "string" ? row.implementation : undefined;
    const note = "note" in row && typeof row.note === "string" ? row.note : undefined;
    if (!pub || !since) return [];
    return [{ pub, since, source, ...(before ? { before } : {}), ...(implementation ? { implementation } : {}), ...(note ? { note } : {}) }];
  });
}

function bundledManifestCoverage(listed: Array<{ pub: string }>, packages: PackageHit[], table: BundledManifest[]): { status: "covered" | "partial"; details: string[] } {
  const details: string[] = [];
  const uncovered = listed.filter((item) => {
    const row = table.find((entry) => entry.pub === item.pub);
    if (!row) {
      details.push(`${item.pub} is a listed SDK and is not in the bundled privacy-manifest table, so it is not treated as covered.`);
      return true;
    }
    const versionName = row.implementation ?? item.pub;
    const version = packages.find((pkg) => pkg.name === versionName)?.spec ?? "";
    const clean = version.match(/\d+\.\d+\.\d+/)?.[0];
    const inRange = Boolean(clean) && versionAtLeast(clean ?? "", row.since) && !(row.before && versionAtLeast(clean ?? "", row.before));
    if (inRange) {
      details.push(`${item.pub} is covered by ${versionName} ${clean}, which is inside ${row.since}${row.before ? ` and before ${row.before}` : ""}. ${row.note ?? ""}`.trim());
      return false;
    }
    const why = row.note ?? `${versionName} ${clean ?? "was not read"} is outside the versions recorded as shipping PrivacyInfo.xcprivacy (since ${row.since}${row.before ? `, before ${row.before}` : ""}).`;
    details.push(`${item.pub} stays uncovered. ${why}`.trim());
    return true;
  });
  return { status: uncovered.length === 0 ? "covered" : "partial", details };
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.split(/[.+]/).map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
  const left = parse(actual);
  const right = parse(minimum);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function androidAdIdFact(root: string, manifest: string | null, packages: Set<string>, ads: boolean, android: boolean): Promise<FactValue> {
  if (!android || !ads) return "not-applicable";
  if (manifest && adIdRemoved(manifest)) return "removed";
  if (manifest?.includes("com.google.android.gms.permission.AD_ID")) return "declared";
  const merged = await collectFiles(join(root, "android"), 30, (name) => name === "AndroidManifest.xml");
  for (const file of merged) {
    const text = await readText(file, 1_000_000);
    if (text?.includes("com.google.android.gms.permission.AD_ID") && !adIdRemoved(text)) return "declared";
  }
  const gradle = await readText(join(root, "android", "app", "build.gradle"), 1_000_000)
    ?? await readText(join(root, "android", "app", "build.gradle.kts"), 1_000_000);
  if (packages.has("google_mobile_ads") || gradle?.includes("play-services-ads")) return "merged-by-sdk";
  return "missing";
}

function adIdRemoved(text: string): boolean {
  return /<uses-permission\b[^>]*com\.google\.android\.gms\.permission\.AD_ID[^>]*tools:node\s*=\s*"remove"|tools:node\s*=\s*"remove"[^>]*com\.google\.android\.gms\.permission\.AD_ID/.test(text);
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
