import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { readArtifact, unzip } from "../../artifact/src/index.ts";

/**
 * Live device checks for `launchymind run` and `scan --live`. Android uses adb
 * with a connected device or a running emulator; iOS uses xcrun simctl with a
 * booted simulator. Without the tool or a device, every check is
 * "not-checked". Nothing here decides a verdict: the launch result becomes a
 * fact for the rule engine, and the rest is evidence for a person to read.
 */
export type CheckStatus = "pass" | "fail" | "found" | "not-found" | "not-checked" | "not-applicable";

export interface DeviceCheck {
  id: "launch.crash" | "ui.privacy-link" | "ui.support-link" | "ui.account-deletion" | "permission.prompts" | "permission.purpose-strings" | "att.prompt";
  status: CheckStatus;
  detail: string;
}

export interface DeviceSession {
  platform: "android" | "ios";
  artifact: string;
  appId: string | null;
  device: string | null;
  checks: DeviceCheck[];
  screenshots: string[];
}

export interface DeviceRunner {
  which(command: string): Promise<boolean>;
  run(command: string, args: string[], timeoutMs?: number): Promise<{ code: number; stdout: Buffer; stderr: string }>;
  sleep(ms: number): Promise<void>;
}

export const systemDeviceRunner: DeviceRunner = {
  async which(command) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir && existsSync(join(dir, command))) return true;
    return false;
  },
  run(command, args, timeoutMs = 120_000) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-4000); });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout: Buffer.alloc(0), stderr: error.message }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }); });
    });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const ALL: DeviceCheck["id"][] = ["launch.crash", "ui.privacy-link", "ui.support-link", "ui.account-deletion", "permission.prompts", "permission.purpose-strings", "att.prompt"];

function notChecked(reason: string, platform: "android" | "ios"): DeviceCheck[] {
  return ALL.map((id) => ({ id, status: id === "att.prompt" && platform === "android" ? "not-applicable" : "not-checked", detail: id === "att.prompt" && platform === "android" ? "App Tracking Transparency is iOS only." : reason }));
}

/** Words that mark a link or button on the first screen. English only: other languages stay not-found, never a pass. */
const PATTERNS = {
  privacy: /privacy|gizlilik|datenschutz|confidentialit|privacidad|privacidade/i,
  support: /support|help|contact|destek|yardım|hilfe|ayuda|aide|ajuda/i,
  deletion: /delete (my )?account|account deletion|hesab(ı|ımı) sil|konto löschen|supprimer (mon |le )?compte|eliminar (mi )?cuenta|excluir conta/i,
};

const PERMISSION_PACKAGES = new Set(["com.android.permissioncontroller", "com.google.android.permissioncontroller", "com.android.packageinstaller"]);

export interface UiNode { text: string; desc: string; pkg: string; resource: string }

export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const attr = (tag: string, name: string) => {
    const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return match ? match[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'") : "";
  };
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = match[0];
    nodes.push({ text: attr(tag, "text"), desc: attr(tag, "content-desc"), pkg: attr(tag, "package"), resource: attr(tag, "resource-id") });
  }
  return nodes;
}

function uiChecks(nodes: UiNode[], appId: string, accounts: boolean): DeviceCheck[] {
  const words = nodes.filter((node) => node.pkg === appId).map((node) => `${node.text} ${node.desc}`.trim()).filter(Boolean);
  const find = (pattern: RegExp) => words.find((word) => pattern.test(word));
  const onScreen = (id: DeviceCheck["id"], pattern: RegExp, label: string): DeviceCheck => {
    if (nodes.length === 0) return { id, status: "not-checked", detail: "The screen's UI tree could not be read." };
    const hit = find(pattern);
    return hit
      ? { id, status: "found", detail: `"${hit.slice(0, 80)}" is on the first screen.` }
      : { id, status: "not-found", detail: `No ${label} text on the first screen. It may be on another screen; this is not a failure.` };
  };
  const prompts = nodes.filter((node) => PERMISSION_PACKAGES.has(node.pkg) && node.text).map((node) => node.text);
  const appNodes = nodes.some((node) => node.pkg === appId);
  return [
    onScreen("ui.privacy-link", PATTERNS.privacy, "privacy"),
    onScreen("ui.support-link", PATTERNS.support, "support or contact"),
    accounts ? onScreen("ui.account-deletion", PATTERNS.deletion, "account deletion") : { id: "ui.account-deletion", status: "not-applicable", detail: "The scan found no account sign-in." },
    nodes.length === 0
      ? { id: "permission.prompts", status: "not-checked", detail: "The screen's UI tree could not be read." }
      : prompts.length > 0
        ? { id: "permission.prompts", status: "found", detail: `A system permission dialog is on screen at launch: "${prompts.slice(0, 3).join(" / ").slice(0, 200)}". Google asks apps to request permissions in context.` }
        : { id: "permission.prompts", status: "not-found", detail: appNodes ? "No system permission dialog at launch." : "The app's window was not in the UI tree." },
  ];
}

export interface LiveOptions {
  runner?: DeviceRunner;
  settleMs?: number;
  screenshotDir?: string;
  accounts?: boolean;
}

export async function runOnAndroid(artifact: string, options: LiveOptions = {}): Promise<DeviceSession> {
  const runner = options.runner ?? systemDeviceRunner;
  const read = await readArtifact(artifact).catch(() => null);
  const appId = read?.appId ?? null;
  const session: DeviceSession = { platform: "android", artifact, appId, device: null, checks: [], screenshots: [] };
  if (!read || read.kind === "ipa") return { ...session, checks: notChecked("The artifact is not an Android APK.", "android") };
  if (read.kind === "aab") return { ...session, checks: notChecked("An AAB cannot be installed directly. Build an APK (bundletool build-apks) and run that.", "android") };
  if (!appId) return { ...session, checks: notChecked("The APK manifest package name was not read.", "android") };
  if (!await runner.which("adb")) return { ...session, checks: notChecked("adb was not found on PATH.", "android") };
  const devices = (await runner.run("adb", ["devices"])).stdout.toString("utf8").split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === "device").map((parts) => parts[0]!);
  const serial = devices[0];
  if (!serial) return { ...session, checks: notChecked("No Android device or emulator is connected (adb devices).", "android") };
  session.device = serial;
  const adb = (...args: string[]) => runner.run("adb", ["-s", serial, ...args]);
  const install = await adb("install", "-r", artifact);
  if (install.code !== 0) return { ...session, checks: notChecked(`adb install failed: ${install.stderr.trim().slice(0, 200) || install.stdout.toString("utf8").trim().slice(0, 200)}`, "android") };
  await adb("logcat", "-c");
  await adb("shell", "am", "force-stop", appId);
  const launch = await adb("shell", "monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1");
  if (launch.code !== 0) return { ...session, checks: notChecked(`The app could not be started: ${launch.stderr.trim().slice(0, 200)}`, "android") };
  await runner.sleep(options.settleMs ?? 8000);
  const pid = (await adb("shell", "pidof", appId)).stdout.toString("utf8").trim();
  const crashLog = (await adb("logcat", "-d", "-b", "crash")).stdout.toString("utf8");
  const crashed = crashLog.includes(appId) || pid === "";
  const crashLine = crashLog.split("\n").find((line) => line.includes("FATAL EXCEPTION") || line.includes(appId))?.trim();
  session.checks.push(crashed
    ? { id: "launch.crash", status: "fail", detail: pid === "" ? `The process was not running ${Math.round((options.settleMs ?? 8000) / 1000)} s after launch.${crashLine ? ` Crash log: ${crashLine.slice(0, 200)}` : ""}` : `The crash buffer names the app: ${crashLine?.slice(0, 200) ?? appId}` }
    : { id: "launch.crash", status: "pass", detail: `Still running ${Math.round((options.settleMs ?? 8000) / 1000)} s after launch (pid ${pid}); the crash buffer does not name the app.` });
  const dumped = await adb("shell", "uiautomator", "dump", "/sdcard/launchymind-ui.xml");
  const xml = dumped.code === 0 ? (await adb("exec-out", "cat", "/sdcard/launchymind-ui.xml")).stdout.toString("utf8") : "";
  session.checks.push(...uiChecks(parseUiDump(xml), appId, options.accounts === true));
  session.checks.push({ id: "permission.purpose-strings", status: "not-applicable", detail: `Android shows no developer purpose string in the system dialog. Declared permissions: ${(read.permissions ?? []).join(", ") || "none read"}.` });
  session.checks.push({ id: "att.prompt", status: "not-applicable", detail: "App Tracking Transparency is iOS only." });
  if (options.screenshotDir) {
    const shot = await adb("exec-out", "screencap", "-p");
    if (shot.code === 0 && shot.stdout.subarray(0, 4).toString("latin1") === "\x89PNG") {
      await mkdir(options.screenshotDir, { recursive: true });
      const path = join(options.screenshotDir, `android-${appId}-launch.png`);
      await writeFile(path, shot.stdout);
      session.screenshots.push(path);
    }
  }
  await adb("shell", "am", "force-stop", appId);
  return session;
}

export async function runOnIosSimulator(artifact: string, options: LiveOptions = {}): Promise<DeviceSession> {
  const runner = options.runner ?? systemDeviceRunner;
  const read = await readArtifact(artifact).catch(() => null);
  const appId = read?.appId ?? null;
  const session: DeviceSession = { platform: "ios", artifact, appId, device: null, checks: [], screenshots: [] };
  if (!read || read.kind !== "ipa") return { ...session, checks: notChecked("The artifact is not an IPA.", "ios") };
  if (!appId) return { ...session, checks: notChecked("CFBundleIdentifier was not read from Info.plist.", "ios") };
  if (!await runner.which("xcrun")) return { ...session, checks: notChecked("xcrun was not found on PATH (Xcode is needed).", "ios") };
  const list = await runner.run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  let udid: string | null = null;
  try {
    const parsed = JSON.parse(list.stdout.toString("utf8")) as { devices?: Record<string, Array<{ udid: string; state: string }>> };
    udid = Object.values(parsed.devices ?? {}).flat().find((item) => item.state === "Booted")?.udid ?? null;
  } catch {
    udid = null;
  }
  if (!udid) return { ...session, checks: notChecked("No booted iOS simulator (xcrun simctl list devices booted).", "ios") };
  session.device = udid;
  const work = await mkdtemp(join(tmpdir(), "launchymind-sim-"));
  try {
    const files = unzip(await readFile(artifact));
    const appDir = [...files.keys()].find((name) => /^Payload\/[^/]+\.app\//.test(name))?.split("/").slice(0, 2).join("/");
    if (!appDir) return { ...session, checks: notChecked("The IPA has no Payload/*.app.", "ios") };
    for (const [name, data] of files) {
      if (!name.startsWith(`${appDir}/`) || name.endsWith("/")) continue;
      const target = join(work, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    const sim = (...args: string[]) => runner.run("xcrun", ["simctl", ...args]);
    const install = await sim("install", udid, join(work, appDir));
    if (install.code !== 0) return { ...session, checks: notChecked(`simctl install failed (a device build does not run on the simulator): ${install.stderr.trim().slice(0, 200)}`, "ios") };
    await sim("terminate", udid, appId);
    const launch = await sim("launch", udid, appId);
    if (launch.code !== 0) {
      session.checks.push({ id: "launch.crash", status: "fail", detail: `simctl launch failed: ${launch.stderr.trim().slice(0, 200)}` });
    } else {
      await runner.sleep(options.settleMs ?? 8000);
      const running = (await sim("spawn", udid, "launchctl", "list")).stdout.toString("utf8").includes(`UIKitApplication:${appId}`);
      session.checks.push(running
        ? { id: "launch.crash", status: "pass", detail: `Still running ${Math.round((options.settleMs ?? 8000) / 1000)} s after launch on the simulator.` }
        : { id: "launch.crash", status: "fail", detail: `The app was not running ${Math.round((options.settleMs ?? 8000) / 1000)} s after launch. Check the simulator crash report.` });
    }
    const reason = "simctl cannot read the text on screen, so this was not checked. Look at the screenshot.";
    session.checks.push({ id: "ui.privacy-link", status: "not-checked", detail: reason });
    session.checks.push({ id: "ui.support-link", status: "not-checked", detail: reason });
    session.checks.push({ id: "ui.account-deletion", status: options.accounts ? "not-checked" : "not-applicable", detail: options.accounts ? reason : "The scan found no account sign-in." });
    session.checks.push({ id: "permission.prompts", status: "not-checked", detail: reason });
    const keys = read.permissions ?? [];
    session.checks.push({ id: "permission.purpose-strings", status: keys.length ? "found" : "not-found", detail: keys.length ? `Info.plist in the IPA has purpose strings for: ${keys.join(", ")}.` : "The IPA Info.plist has no NS*UsageDescription strings." });
    session.checks.push({ id: "att.prompt", status: "not-checked", detail: "Whether the App Tracking Transparency prompt appeared cannot be read from simctl. Look at the screenshot." });
    if (options.screenshotDir) {
      await mkdir(options.screenshotDir, { recursive: true });
      const path = join(options.screenshotDir, `ios-${appId}-launch.png`);
      const shot = await sim("io", udid, "screenshot", path);
      if (shot.code === 0 && existsSync(path)) session.screenshots.push(path);
    }
    await sim("terminate", udid, appId);
    return session;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function runLive(artifact: string, options: LiveOptions = {}): Promise<DeviceSession> {
  const read = await readArtifact(artifact).catch(() => null);
  if (read?.kind === "ipa") return runOnIosSimulator(artifact, options);
  return runOnAndroid(artifact, options);
}

/** The one fact per platform the rule engine reads. */
export function launchFacts(sessions: readonly DeviceSession[]): Record<string, "ok" | "crashed" | "unknown"> {
  const facts: Record<string, "ok" | "crashed" | "unknown"> = {};
  for (const session of sessions) {
    const check = session.checks.find((item) => item.id === "launch.crash");
    const value = check?.status === "pass" ? "ok" : check?.status === "fail" ? "crashed" : "unknown";
    const key = `live.device.${session.platform}_launch`;
    if (facts[key] === "crashed") continue;
    facts[key] = value;
  }
  return facts;
}
