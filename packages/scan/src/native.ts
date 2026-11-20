import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface NativePackage {
  name: string;
  spec: string | null;
  path: string;
  line: number | null;
}

export interface NativeLayout {
  hasPbx: boolean;
  hasAppGradle: boolean;
  unity: boolean;
  unityIos: boolean;
  unityAndroid: boolean;
  dependencyManifest: boolean;
  packages: NativePackage[];
  productName: string | null;
  bundleVersion: string | null;
  androidTargetSdk: number | null;
  notes: string[];
}

const SKIP = new Set(["Pods", ".symlinks", "build", "node_modules", "Library", "Temp", ".git", "DerivedData", "dist"]);

/** Pod, SPM, and Unity package ids mapped only when they are the same SDK already named in the SDK knowledge base. */
const ALIASES: Record<string, string> = {
  "google-mobile-ads-sdk": "google_mobile_ads",
  googlemobileads: "google_mobile_ads",
  "com.google.android.gms:play-services-ads": "google_mobile_ads",
  applovinsdk: "applovin_max",
  "applovin-max": "applovin_max",
  unityads: "unity_ads_plugin",
  "com.unity.ads": "unity_ads_plugin",
  ironsource: "ironsource_mediation",
  ironsourcesdk: "ironsource_mediation",
  "com.unity.ads.mediation": "ironsource_mediation",
  firebaseanalytics: "firebase_analytics",
  "com.google.firebase:firebase-analytics": "firebase_analytics",
  firebasecrashlytics: "firebase_crashlytics",
  "com.google.firebase:firebase-crashlytics": "firebase_crashlytics",
  firebasemessaging: "firebase_messaging",
  "com.google.firebase:firebase-messaging": "firebase_messaging",
  adjustsdk: "adjust_sdk",
  "com.adjust.sdk:adjust-android": "adjust_sdk",
  appsflyerframework: "appsflyer_sdk",
  appsflyer: "appsflyer_sdk",
  "com.appsflyer:af-android-sdk": "appsflyer_sdk",
  purchases: "revenuecat",
  revenuecat: "revenuecat",
  revenuecatui: "revenuecat",
  "purchases-ios": "revenuecat",
  "purchases-ios-spm": "revenuecat",
  "com.revenuecat.purchases:purchases": "revenuecat",
  "com.revenuecat.purchases:purchases-ui": "revenuecat",
  "com.revenuecat.purchases-unity": "revenuecat",
  "com.revenuecat.purchases-ui-unity": "revenuecat",
  "com.android.billingclient:billing": "com.android.billingclient:billing",
  "com.android.billingclient:billing-ktx": "com.android.billingclient:billing",
  sentry: "sentry_flutter",
  "io.sentry:sentry-android": "sentry_flutter",
};

export async function detectNative(root: string): Promise<NativeLayout> {
  const notes: string[] = [];
  const packages: NativePackage[] = [];
  const pbx = await findFiles(root, 30, (name) => name === "project.pbxproj");
  const assetText = await readMaybe(join(root, "ProjectSettings", "ProjectSettings.asset"));
  const unity = assetText !== null;
  const unityFields = assetText ? readUnityAsset(assetText) : { productName: null, bundleVersion: null, ios: false, android: false, targetSdk: null };
  const podLock = await readMaybe(join(root, "Podfile.lock")) ?? await readMaybe(join(root, "ios", "Podfile.lock"));
  if (podLock) packages.push(...pods(podLock, podLock === await readMaybe(join(root, "Podfile.lock")) ? "Podfile.lock" : "ios/Podfile.lock"));
  for (const resolved of await findFiles(root, 20, (name) => name === "Package.resolved")) {
    const text = await readMaybe(resolved);
    if (text) packages.push(...spm(text, relative(root, resolved)));
  }
  const unityManifest = await readMaybe(join(root, "Packages", "manifest.json"));
  if (unityManifest) packages.push(...unityPackages(unityManifest));
  const gradleFiles = [
    "android/app/build.gradle",
    "android/app/build.gradle.kts",
    "app/build.gradle",
    "app/build.gradle.kts",
  ];
  let hasAppGradle = false;
  for (const relativePath of gradleFiles) {
    const text = await readMaybe(join(root, relativePath));
    if (text === null) continue;
    hasAppGradle = true;
    packages.push(...gradleCoordinates(text, relativePath));
  }
  const catalog = await readMaybe(join(root, "gradle", "libs.versions.toml"));
  if (catalog) packages.push(...catalogLibraries(catalog));
  const dependencyManifest = Boolean(podLock || unityManifest || hasAppGradle || packages.some((item) => item.path.endsWith("Package.resolved")));
  if (pbx.length === 0 && !hasAppGradle && !unity) notes.push("No Xcode project, app Gradle file, or Unity project settings were found.");
  return {
    hasPbx: pbx.length > 0,
    hasAppGradle,
    unity,
    unityIos: unityFields.ios,
    unityAndroid: unityFields.android,
    dependencyManifest,
    packages: dedupe(packages),
    productName: unityFields.productName,
    bundleVersion: unityFields.bundleVersion,
    androidTargetSdk: unityFields.targetSdk,
    notes,
  };
}

export function aliasPackage(name: string): string {
  const key = name.trim().toLowerCase();
  return ALIASES[key] ?? name;
}

async function findFiles(root: string, limit: number, accept: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files, limit, accept);
  return files;
}

async function walk(dir: string, files: string[], limit: number, accept: (name: string) => boolean): Promise<void> {
  if (files.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= limit) return;
    if (entry.name.startsWith(".") || SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files, limit, accept);
    else if (entry.isFile() && accept(entry.name) && !full.split(sep).some((part) => SKIP.has(part))) files.push(full);
  }
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function pods(text: string, path: string): NativePackage[] {
  const block = text.match(/^PODS:\n([\s\S]*?)\n\n/m)?.[1] ?? "";
  const hits: NativePackage[] = [];
  for (const match of block.matchAll(/^\s+-\s+([^(\s]+)/gm)) {
    const raw = match[1];
    if (!raw) continue;
    const name = aliasPackage(raw.split("/")[0] ?? raw);
    hits.push({ name, spec: null, path, line: lineOf(text, match.index ?? 0) });
  }
  return hits;
}

function spm(text: string, path: string): NativePackage[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  const pins = document && typeof document === "object" && "pins" in document && Array.isArray(document.pins) ? document.pins : [];
  const hits: NativePackage[] = [];
  for (const pin of pins) {
    if (!pin || typeof pin !== "object" || !("identity" in pin) || typeof pin.identity !== "string") continue;
    const version = "state" in pin && pin.state && typeof pin.state === "object" && "version" in pin.state && typeof pin.state.version === "string" ? pin.state.version : null;
    hits.push({ name: aliasPackage(pin.identity), spec: version, path, line: null });
  }
  return hits;
}

function unityPackages(text: string): NativePackage[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  const deps = document && typeof document === "object" && "dependencies" in document && document.dependencies && typeof document.dependencies === "object" ? document.dependencies : null;
  if (!deps) return [];
  return Object.entries(deps).flatMap(([name, spec]) => {
    if (name.startsWith("com.unity.modules.")) return [];
    return [{ name: aliasPackage(name), spec: typeof spec === "string" ? spec : null, path: "Packages/manifest.json", line: lineOf(text, name) }];
  });
}

function gradleCoordinates(text: string, path: string): NativePackage[] {
  const hits: NativePackage[] = [];
  for (const match of text.matchAll(/["']([a-z0-9.]+):([a-z0-9._-]+)(?::[^"']+)?["']/gi)) {
    const group = match[1];
    const artifact = match[2];
    if (!group || !artifact) continue;
    const coordinate = `${group}:${artifact}`;
    hits.push({ name: aliasPackage(coordinate), spec: null, path, line: lineOf(text, match.index ?? 0) });
  }
  return hits;
}

function catalogLibraries(text: string): NativePackage[] {
  const hits: NativePackage[] = [];
  for (const match of text.matchAll(/module\s*=\s*"([a-z0-9.]+):([a-z0-9._-]+)"/gi)) {
    const group = match[1];
    const artifact = match[2];
    if (!group || !artifact) continue;
    hits.push({ name: aliasPackage(`${group}:${artifact}`), spec: null, path: "gradle/libs.versions.toml", line: lineOf(text, match.index ?? 0) });
  }
  return hits;
}

export async function versionCatalog(root: string): Promise<Record<string, string>> {
  const text = await readMaybe(join(root, "gradle", "libs.versions.toml"));
  if (!text) return {};
  const versions = text.match(/\[versions\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const match of versions.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*"?([^"\n#]+)"?\s*$/gm)) {
    const key = match[1];
    const value = match[2]?.trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function substituteCatalog(text: string, versions: Record<string, string>): string {
  return text.replace(/libs\.versions\.([A-Za-z0-9_-]+)(?:\.get\(\))?(?:\.toInt(?:eger)?\(\))?/g, (full, name: string) => versions[name] ?? full);
}

function readUnityAsset(text: string): { productName: string | null; bundleVersion: string | null; ios: boolean; android: boolean; targetSdk: number | null } {
  const productName = text.match(/^  productName:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const bundleVersion = text.match(/^  bundleVersion:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const targetRaw = text.match(/^  AndroidTargetSdkVersion:\s*(\d+)/m)?.[1];
  const targetSdk = targetRaw ? Number(targetRaw) : null;
  return {
    productName: productName && productName !== "null" ? productName : null,
    bundleVersion: bundleVersion && bundleVersion !== "null" ? bundleVersion : null,
    ios: /^  iPhone:/m.test(text) || /applicationIdentifier:[\s\S]{0,400}iPhone:/m.test(text),
    android: /^  AndroidTargetSdkVersion:/m.test(text) || /applicationIdentifier:[\s\S]{0,400}Android:/m.test(text),
    targetSdk: targetSdk !== null && Number.isInteger(targetSdk) ? targetSdk : null,
  };
}

function dedupe(packages: NativePackage[]): NativePackage[] {
  const seen = new Set<string>();
  const out: NativePackage[] = [];
  for (const item of packages) {
    const key = `${item.name}@${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function lineOf(text: string, indexOrName: number | string): number | null {
  const index = typeof indexOrName === "number" ? indexOrName : text.indexOf(indexOrName);
  if (index < 0) return null;
  return text.slice(0, index).split(/\r?\n/).length;
}
