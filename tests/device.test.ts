import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBinaryXml, encodePlist, encodeProtoManifest, readArtifact, zipFiles } from "../packages/artifact/src/index.ts";
import { parseUiDump, runOnAndroid, runOnIosSimulator, type DeviceRunner } from "../packages/device/src/index.ts";
import { runArtifactOnly } from "../packages/pipeline/src/index.ts";
import { renderHtml, renderTerminal } from "../packages/report/src/index.ts";

const now = new Date("2026-11-20T00:00:00Z");
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(16)]);
const status = (report: Awaited<ReturnType<typeof runArtifactOnly>>, id: string) => report.findings.find((item) => item.ruleId === id)?.status;

async function apk(dir: string): Promise<string> {
  const path = join(dir, "app.apk");
  await writeFile(path, zipFiles([{ name: "AndroidManifest.xml", data: encodeBinaryXml(35, ["android.permission.CAMERA"]) }]));
  return path;
}

async function ipa(dir: string): Promise<string> {
  const path = join(dir, "app.ipa");
  await writeFile(path, zipFiles([
    { name: "Payload/Runner.app/Info.plist", data: encodePlist({ CFBundleIdentifier: "dev.example.ios", NSCameraUsageDescription: "Scan receipts" }) },
    { name: "Payload/Runner.app/Runner", data: Buffer.from("binary") },
  ]));
  return path;
}

const uiXml = (pkg: string, extra = "") => `<?xml version="1.0"?><hierarchy><node package="${pkg}" text="Welcome" content-desc=""/><node package="${pkg}" text="Privacy Policy" content-desc=""/><node package="${pkg}" text="" content-desc="Help &amp; support"/>${extra}</hierarchy>`;

function adbMock(appId: string, opts: { crash?: boolean; devices?: boolean; prompt?: boolean } = {}): { runner: DeviceRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: DeviceRunner = {
    which: async (command) => command === "adb",
    sleep: async () => {},
    run: async (_command, args) => {
      const line = args.join(" ");
      calls.push(line);
      const out = (text: string | Buffer) => ({ code: 0, stdout: Buffer.isBuffer(text) ? text : Buffer.from(text), stderr: "" });
      if (line === "devices") return out(opts.devices === false ? "List of devices attached\n\n" : "List of devices attached\nemulator-5554\tdevice\n");
      if (line.endsWith(`pidof ${appId}`)) return opts.crash ? { code: 1, stdout: Buffer.alloc(0), stderr: "" } : out("4242\n");
      if (line.includes("logcat -d -b crash")) return out(opts.crash ? `--------- beginning of crash\nE AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: ${appId}, PID: 4242\n` : "");
      if (line.includes("exec-out cat")) return out(uiXml(appId, opts.prompt ? `<node package="com.google.android.permissioncontroller" text="Allow app to take pictures and record video?"/>` : ""));
      if (line.includes("screencap")) return out(PNG);
      return out("");
    },
  };
  return { runner, calls };
}

test("the synthetic APK and IPA expose their app id and permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lm-dev-"));
  try {
    const android = await readArtifact(await apk(dir));
    assert.equal(android.appId, "dev.example.artifact");
    assert.deepEqual(android.permissions, ["android.permission.CAMERA"]);
    const ios = await readArtifact(await ipa(dir));
    assert.equal(ios.appId, "dev.example.ios");
    assert.deepEqual(ios.permissions, ["NSCameraUsageDescription"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adb mock: a running app passes the launch rule, links on screen are found, and the screenshot is embedded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lm-dev-"));
  try {
    const { runner, calls } = adbMock("dev.example.artifact");
    const report = await runArtifactOnly(await apk(dir), { offline: true, now, live: true, liveOptions: { runner, settleMs: 1, screenshotDir: join(dir, "shots") } });
    assert.equal(report.facts["live.device.android_launch"], "ok");
    assert.equal(status(report, "google.launch-crash"), "pass");
    const session = report.device?.[0];
    assert.equal(session?.device, "emulator-5554");
    const by = (id: string) => session?.checks.find((item) => item.id === id)?.status;
    assert.equal(by("ui.privacy-link"), "found");
    assert.equal(by("ui.support-link"), "found");
    assert.equal(by("permission.prompts"), "not-found");
    assert.equal(by("att.prompt"), "not-applicable");
    assert.ok(calls.some((line) => line.startsWith("-s emulator-5554 install -r")));
    assert.ok(!calls.some((line) => line.includes("install -g") || line.includes(" -g ")), "permissions are not auto-granted");
    assert.equal(session?.screenshots.length, 1);
    assert.match(renderHtml(report), /<img alt="Screenshot" src="data:image\/png;base64,/);
    assert.match(renderTerminal(report), /Live device checks:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adb mock: a crash on launch fails the blocker rule; a launch-time permission dialog is reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lm-dev-"));
  try {
    const crashed = await runArtifactOnly(await apk(dir), { offline: true, now, live: true, liveOptions: { runner: adbMock("dev.example.artifact", { crash: true }).runner, settleMs: 1 } });
    assert.equal(status(crashed, "google.launch-crash"), "fail");
    assert.equal(crashed.verdict, "reject");
    assert.ok(crashed.device?.[0]?.checks.find((item) => item.id === "launch.crash")?.detail.includes("FATAL EXCEPTION"));
    const prompt = await runOnAndroid(await apk(dir), { runner: adbMock("dev.example.artifact", { prompt: true }).runner, settleMs: 1 });
    assert.equal(prompt.checks.find((item) => item.id === "permission.prompts")?.status, "found");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("without adb or a device every check is not checked and the launch rule stays unchecked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lm-dev-"));
  try {
    const none: DeviceRunner = { which: async () => false, sleep: async () => {}, run: async () => { throw new Error("must not run"); } };
    const report = await runArtifactOnly(await apk(dir), { offline: true, now, live: true, liveOptions: { runner: none } });
    assert.equal(status(report, "google.launch-crash"), "unchecked");
    assert.notEqual(report.verdict, "ready");
    for (const check of report.device?.[0]?.checks ?? []) assert.ok(check.status === "not-checked" || check.status === "not-applicable", check.id);
    const noDevice = await runOnAndroid(await apk(dir), { runner: adbMock("dev.example.artifact", { devices: false }).runner });
    assert.ok(noDevice.checks.every((item) => item.status === "not-checked" || item.status === "not-applicable"));
    assert.match(noDevice.checks[0]?.detail ?? "", /No Android device or emulator/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("simctl mock: the IPA launches on a booted simulator; screen text and ATT stay not checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lm-dev-"));
  try {
    const calls: string[] = [];
    const runner: DeviceRunner = {
      which: async (command) => command === "xcrun",
      sleep: async () => {},
      run: async (_command, args) => {
        const line = args.join(" ");
        calls.push(line);
        const out = (text: string) => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
        if (line.startsWith("simctl list devices booted")) return out(JSON.stringify({ devices: { "iOS-26-0": [{ udid: "SIM-1", state: "Booted" }] } }));
        if (line.startsWith("simctl spawn SIM-1 launchctl list")) return out("123\t0\tUIKitApplication:dev.example.ios[abcd]\n");
        if (line.startsWith("simctl io SIM-1 screenshot")) { await writeFile(args[args.length - 1]!, PNG); return out(""); }
        return out("");
      },
    };
    const session = await runOnIosSimulator(await ipa(dir), { runner, settleMs: 1, screenshotDir: join(dir, "shots") });
    const by = (id: string) => session.checks.find((item) => item.id === id)?.status;
    assert.equal(by("launch.crash"), "pass");
    assert.equal(by("ui.privacy-link"), "not-checked");
    assert.equal(by("att.prompt"), "not-checked");
    assert.equal(by("permission.purpose-strings"), "found");
    assert.ok(calls.some((line) => line.startsWith("simctl install SIM-1 ") && line.endsWith("Payload/Runner.app")));
    assert.equal(session.screenshots.length, 1);
    assert.deepEqual(await readFile(session.screenshots[0]!), PNG);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an AAB is not installed and a UI dump is parsed with entities", async () => {
  const nodes = parseUiDump(`<node package="a" text="Terms &amp; Privacy" content-desc="x"/>`);
  assert.equal(nodes[0]?.text, "Terms & Privacy");
  const dir = await mkdtemp(join(tmpdir(), "lm-dev-"));
  try {
    const path = join(dir, "app.aab");
    await writeFile(path, zipFiles([{ name: "base/manifest/AndroidManifest.xml", data: encodeProtoManifest(35, []) }]));
    const { runner, calls } = adbMock("dev.example.artifact");
    const session = await runOnAndroid(path, { runner });
    assert.match(session.checks[0]?.detail ?? "", /AAB cannot be installed/);
    assert.equal(calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
