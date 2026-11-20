import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Evidence, FactValue } from "../../core/src/index.ts";

export interface ConnectConfig {
  apple: { keyId: string; issuerId: string; keyPath: string; bundleId: string | null } | null;
  google: { jsonPath: string; packageName: string } | null;
}

export interface ConnectReport {
  facts: Record<string, FactValue>;
  evidence: Array<Omit<Evidence, "id">>;
  manual: string[];
  lines: string[];
}

const APPLE = "https://api.appstoreconnect.apple.com";
const PLAY = "https://androidpublisher.googleapis.com/androidpublisher/v3";

export function readConnectConfig(env: Record<string, string | undefined>): ConnectConfig {
  const keyId = env.LAUNCHYMIND_ASC_KEY_ID?.trim() ?? "";
  const issuerId = env.LAUNCHYMIND_ASC_ISSUER_ID?.trim() ?? "";
  const keyPath = env.LAUNCHYMIND_ASC_KEY_PATH?.trim() ?? "";
  const bundleId = env.LAUNCHYMIND_ASC_BUNDLE_ID?.trim() || null;
  const jsonPath = env.LAUNCHYMIND_PLAY_JSON?.trim() ?? "";
  const packageName = env.LAUNCHYMIND_PLAY_PACKAGE?.trim() ?? "";
  return {
    apple: keyId && issuerId && keyPath ? { keyId, issuerId, keyPath, bundleId } : null,
    google: jsonPath && packageName ? { jsonPath, packageName } : null,
  };
}

export async function readConnect(config: ConnectConfig, fetchImpl: typeof fetch, offline: boolean): Promise<ConnectReport> {
  const facts: Record<string, FactValue> = {
    "connect.apple": config.apple ? (offline ? "skipped" : "off") : "off",
    "connect.google": config.google ? (offline ? "skipped" : "off") : "off",
  };
  const evidence: Array<Omit<Evidence, "id">> = [];
  const manual = [
    "Xcode and the iOS SDK version are not in the App Store Connect build record. The build exposes minOsVersion only, so attestation.apple.xcode-sdk stays manual.",
    "Play Data safety is a write-only method (POST applications.dataSafety). It cannot be read, so the Data safety and advertising-ID answers stay manual.",
    "The Play tracks resource does not include the 12-tester or 14-day closed-test clock, so google.closed-test stays manual.",
  ];
  const lines = [...manual];
  if (!config.apple && !config.google) {
    lines.unshift("Store console keys are not configured. Set the environment variables named in docs/connect.md. Do not commit them.");
    return { facts, evidence, manual, lines };
  }
  if (offline) {
    lines.unshift("Connect is configured and was not called because the scan is offline.");
    return { facts, evidence, manual, lines };
  }
  if (config.apple) {
    try {
      const apple = await readApple(config.apple, fetchImpl);
      facts["connect.apple"] = "read";
      Object.assign(facts, apple.facts);
      evidence.push(...apple.evidence);
      lines.unshift(...apple.lines);
    } catch (error) {
      facts["connect.apple"] = "error";
      lines.unshift(`App Store Connect was not read. ${safeError(error)}`);
    }
  }
  if (config.google) {
    try {
      const google = await readGoogle(config.google, fetchImpl);
      facts["connect.google"] = "read";
      Object.assign(facts, google.facts);
      evidence.push(...google.evidence);
      lines.unshift(...google.lines);
    } catch (error) {
      facts["connect.google"] = "error";
      lines.unshift(`Google Play was not read. ${safeError(error)}`);
    }
  }
  return { facts, evidence, manual, lines };
}

async function readApple(config: NonNullable<ConnectConfig["apple"]>, fetchImpl: typeof fetch): Promise<{ facts: Record<string, FactValue>; evidence: Array<Omit<Evidence, "id">>; lines: string[] }> {
  const pem = await readFile(config.keyPath, "utf8");
  if (!pem.includes("PRIVATE KEY")) throw new Error("Apple key file is not a private key.");
  const token = signEs256(pem, config.keyId, config.issuerId);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const apps = await getJson(fetchImpl, `${APPLE}/v1/apps?limit=20`, headers);
  const list = arrayData(apps);
  const app = list.find((item) => item.attributes?.bundleId === config.bundleId) ?? (config.bundleId ? null : list[0]);
  if (!app?.id) throw new Error(config.bundleId ? "No App Store Connect app matched that bundle id." : "No App Store Connect app was returned.");
  const facts: Record<string, FactValue> = {};
  const evidence: Array<Omit<Evidence, "id">> = [];
  const lines: string[] = [];
  const info = await getJson(fetchImpl, `${APPLE}/v1/apps/${app.id}/appInfos?include=appInfoLocalizations&limit=5`, headers);
  const privacy = included(info).map((item) => stringAttr(item, "privacyPolicyUrl")).find(Boolean) ?? null;
  if (privacy) {
    facts["urls.privacy.declared"] = true;
    facts["urls.privacy.present"] = true;
    evidence.push(ev(["urls.privacy.declared", "urls.privacy.present"], `App Store Connect app info localization has a privacy policy URL.`, privacy));
    lines.push("Privacy policy URL was read from App Store Connect. The in-app link is still a separate check.");
  }
  const versions = await getJson(fetchImpl, `${APPLE}/v1/apps/${app.id}/appStoreVersions?include=appStoreVersionLocalizations&limit=5`, headers);
  const support = included(versions).map((item) => stringAttr(item, "supportUrl")).find(Boolean) ?? null;
  if (support) {
    facts["urls.support.present"] = true;
    evidence.push(ev(["urls.support.present"], "App Store Connect version localization has a support URL.", support));
    lines.push("Support URL was read from App Store Connect. It is not treated as an in-app link.");
  }
  const age = await getJson(fetchImpl, `${APPLE}/v1/apps/${app.id}/ageRatingDeclaration`, headers);
  const ageAttributes = objectData(age)?.attributes ?? null;
  if (ageAttributes && Object.keys(ageAttributes).length > 0) {
    facts["attestation.apple.age_rating"] = "yes";
    evidence.push(ev(["attestation.apple.age_rating"], "App Store Connect returned an age rating declaration. The declaration values were not copied into the report.", "ageRatingDeclaration"));
    lines.push("Age rating declaration was present. The individual answers are not stored here.");
  }
  const builds = await getJson(fetchImpl, `${APPLE}/v1/builds?filter[app]=${encodeURIComponent(app.id)}&sort=-uploadedDate&limit=1&fields[builds]=minOsVersion,version,uploadedDate`, headers);
  const build = arrayData(builds)[0];
  const minOs = build ? stringAttr(build, "minOsVersion") : null;
  if (minOs && Number.isFinite(Number(minOs))) {
    facts["ios.deployment_target"] = Number(minOs);
    evidence.push(ev(["ios.deployment_target"], `Latest build minOsVersion is ${minOs}. The API does not include the Xcode or SDK version.`, minOs));
    lines.push(`Build minimum OS is ${minOs}. Xcode and the SDK stay manual.`);
  } else {
    lines.push("No build minOsVersion was returned. Xcode and the SDK stay manual.");
  }
  return { facts, evidence, lines };
}

async function readGoogle(config: NonNullable<ConnectConfig["google"]>, fetchImpl: typeof fetch): Promise<{ facts: Record<string, FactValue>; evidence: Array<Omit<Evidence, "id">>; lines: string[] }> {
  const raw = await readFile(config.jsonPath, "utf8");
  const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string; token_uri?: string };
  if (!parsed.client_email || !parsed.private_key) throw new Error("Play service account file is missing client_email or private_key.");
  const assertion = signRs256(parsed.private_key, parsed.client_email, parsed.token_uri ?? "https://oauth2.googleapis.com/token");
  const tokenResponse = await fetchImpl(parsed.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`,
  });
  const tokenJson = await tokenResponse.json() as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("Play token endpoint did not return an access token.");
  const headers = { Authorization: `Bearer ${tokenJson.access_token}`, Accept: "application/json" };
  const edit = await getJson(fetchImpl, `${PLAY}/applications/${encodeURIComponent(config.packageName)}/edits`, headers, "POST");
  const editId = typeof edit.id === "string" ? edit.id : "";
  if (!editId) throw new Error("Play did not open an edit.");
  try {
    const tracks = await getJson(fetchImpl, `${PLAY}/applications/${encodeURIComponent(config.packageName)}/edits/${encodeURIComponent(editId)}/tracks`, headers);
    const names = new Set<string>();
    const list = Array.isArray(tracks.tracks) ? tracks.tracks : [];
    for (const track of list) {
      if (!track || typeof track !== "object" || !("track" in track) || typeof track.track !== "string") continue;
      const releases = "releases" in track && Array.isArray(track.releases) ? track.releases : [];
      if (releases.length > 0) names.add(track.track);
    }
    const facts: Record<string, FactValue> = {};
    const evidence: Array<Omit<Evidence, "id">> = [];
    const lines: string[] = [];
    if (names.has("production")) facts["google.distribution"] = "production";
    else if (names.has("beta")) facts["google.distribution"] = "open";
    else if (names.has("alpha")) facts["google.distribution"] = "closed";
    else if (names.size === 1 && names.has("internal")) facts["google.distribution"] = "internal-only";
    if (facts["google.distribution"]) {
      evidence.push(ev(["google.distribution"], `Play tracks with releases: ${[...names].join(", ") || "none"}. The edit was deleted and not committed.`, String(facts["google.distribution"])));
      lines.push(`Play distribution was read as ${facts["google.distribution"]}. Data safety was not read.`);
    } else {
      lines.push("Play tracks were read and did not identify a distribution. Data safety was not read.");
    }
    return { facts, evidence, lines };
  } finally {
    await fetchImpl(`${PLAY}/applications/${encodeURIComponent(config.packageName)}/edits/${encodeURIComponent(editId)}`, { method: "DELETE", headers }).catch(() => undefined);
  }
}

function signEs256(pem: string, keyId: string, issuerId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(unsigned);
  const signature = signer.sign({ key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${b64url(signature)}`;
}

function signRs256(pem: string, email: string, audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: audience,
    iat: now,
    exp: now + 600,
    sub: email,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${b64url(signer.sign(createPrivateKey(pem)))}`;
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, method = "GET"): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("The store API did not return JSON.");
  }
}

function arrayData(body: Record<string, unknown>): JsonApi[] {
  return Array.isArray(body.data) ? body.data.filter(isResource) : [];
}

function objectData(body: Record<string, unknown>): JsonApi | null {
  return isResource(body.data) ? body.data : null;
}

function included(body: Record<string, unknown>): JsonApi[] {
  return Array.isArray(body.included) ? body.included.filter(isResource) : [];
}

interface JsonApi { id?: string; attributes?: Record<string, unknown> }

function isResource(value: unknown): value is JsonApi {
  return Boolean(value && typeof value === "object");
}

function stringAttr(resource: JsonApi, key: string): string | null {
  const value = resource.attributes?.[key];
  return typeof value === "string" && value ? value : null;
}

function ev(facts: string[], detail: string, snippet: string): Omit<Evidence, "id"> {
  return { facts, kind: "live", detail, snippet: redact(snippet) };
}

function redact(value: string): string {
  return value.replace(/-----BEGIN[\s\S]*?-----END[^-]+-----/g, "[redacted]").replace(/"private_key"\s*:\s*"[^"]+"/g, "\"private_key\":\"[redacted]\"").slice(0, 180);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed.";
  return redact(message).replace(/Bearer\s+\S+/g, "Bearer [redacted]");
}

function b64url(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  return buffer.toString("base64url");
}
