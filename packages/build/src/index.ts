import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, relative } from "node:path";
import { zipFiles } from "../../artifact/src/index.ts";

/**
 * Opt-in native builds for `scan --build`. A build runs only when its
 * toolchain is on PATH, and always in a temporary copy so the project folder
 * is not touched. A build that did not run or failed adds no artifact facts:
 * the artifact rules stay unchecked, never pass.
 */
export type BuildTarget = "android" | "ios";

export interface BuildOutcome {
  target: BuildTarget;
  status: "built" | "failed" | "not-run";
  reason: string;
  command?: string;
  artifactPath?: string;
  logTail?: string;
}

export interface CommandResult { code: number; output: string }

export interface BuildRunner {
  which(command: string): Promise<boolean>;
  run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult>;
}

const SKIP = new Set(["build", ".gradle", ".dart_tool", "DerivedData", ".git", "Library", "Temp", "obj"]);

export const systemRunner: BuildRunner = {
  async which(command) {
    if (command.includes("/")) return existsSync(command);
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (dir && existsSync(join(dir, command))) return true;
    }
    return false;
  },
  run(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { cwd, env: { ...process.env, CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const add = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-20000); };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => { child.kill("SIGKILL"); output += `\nTimed out after ${Math.round(timeoutMs / 1000)} s.`; }, timeoutMs);
      child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, output: error.message }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
    });
  },
};

interface Plan { target: BuildTarget; tools: string[]; command: string; args: string[]; cwd: string; find: (root: string) => Promise<string | null>; needsZip?: boolean }

async function walk(dir: string, match: (path: string) => boolean, depth = 8): Promise<string[]> {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (match(path)) out.push(path);
    else if (entry.isDirectory()) out.push(...await walk(path, match, depth - 1));
  }
  return out;
}

const firstApk = async (root: string) => (await walk(root, (path) => path.endsWith(".apk")))[0] ?? null;
const firstApp = async (root: string) => (await walk(root, (path) => path.endsWith(".app") && path.includes("iphonesimulator")))[0] ?? null;

export async function planBuilds(root: string): Promise<{ plans: Plan[]; skipped: BuildOutcome[] }> {
  const plans: Plan[] = [];
  const skipped: BuildOutcome[] = [];
  const isFlutter = existsSync(join(root, "pubspec.yaml"));
  const isUnity = existsSync(join(root, "ProjectSettings", "ProjectSettings.asset"));
  if (isUnity) {
    skipped.push({ target: "android", status: "not-run", reason: "Unity builds need the Unity editor in batch mode, which --build does not drive." });
    skipped.push({ target: "ios", status: "not-run", reason: "Unity builds need the Unity editor in batch mode, which --build does not drive." });
    return { plans, skipped };
  }
  if (isFlutter) {
    if (existsSync(join(root, "android"))) plans.push({ target: "android", tools: ["flutter"], command: "flutter", args: ["build", "apk", "--debug"], cwd: root, find: (dir) => firstApk(join(dir, "build", "app", "outputs")) });
    if (existsSync(join(root, "ios"))) plans.push({ target: "ios", tools: ["flutter", "xcodebuild"], command: "flutter", args: ["build", "ios", "--simulator", "--debug", "--no-codesign"], cwd: root, find: (dir) => firstApp(join(dir, "build", "ios")), needsZip: true });
    return { plans, skipped };
  }
  const androidDir = existsSync(join(root, "android", "gradlew")) ? join(root, "android") : existsSync(join(root, "gradlew")) ? root : null;
  if (androidDir) plans.push({ target: "android", tools: ["java"], command: "./gradlew", args: ["--no-daemon", "assembleDebug"], cwd: androidDir, find: (dir) => firstApk(dir) });
  else skipped.push({ target: "android", status: "not-run", reason: "No Gradle wrapper (gradlew) was found." });
  const iosDir = existsSync(join(root, "ios")) ? join(root, "ios") : root;
  const entries = existsSync(iosDir) ? await readdir(iosDir) : [];
  const workspace = entries.find((name) => name.endsWith(".xcworkspace"));
  const project = entries.find((name) => name.endsWith(".xcodeproj"));
  if (workspace || project) {
    const scheme = basename(workspace ?? project ?? "", workspace ? ".xcworkspace" : ".xcodeproj");
    plans.push({
      target: "ios", tools: ["xcodebuild"], command: "xcodebuild",
      args: [workspace ? "-workspace" : "-project", workspace ?? project ?? "", "-scheme", scheme, "-sdk", "iphonesimulator", "-configuration", "Debug", "-derivedDataPath", "DerivedData", "CODE_SIGNING_ALLOWED=NO", "build"],
      cwd: iosDir, find: (dir) => firstApp(join(dir, "DerivedData")), needsZip: true,
    });
  } else skipped.push({ target: "ios", status: "not-run", reason: "No .xcodeproj or .xcworkspace was found." });
  return { plans, skipped };
}

async function zipApp(appDir: string, outPath: string): Promise<void> {
  const files: string[] = [];
  const collect = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if ((await stat(path)).size < 64 * 1024 * 1024) files.push(path);
    }
  };
  await collect(appDir);
  const prefix = `Payload/${basename(appDir)}/`;
  const entries = await Promise.all(files.map(async (path) => ({ name: prefix + relative(appDir, path).split("\\").join("/"), data: await readFile(path) })));
  await writeFile(outPath, zipFiles(entries));
}

export async function buildProject(projectPath: string, options: { runner?: BuildRunner; timeoutMs?: number; keep?: boolean } = {}): Promise<{ outcomes: BuildOutcome[]; workDir: string | null; cleanup: () => Promise<void> }> {
  const runner = options.runner ?? systemRunner;
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const { plans, skipped } = await planBuilds(projectPath);
  const outcomes: BuildOutcome[] = [...skipped];
  const runnable: Plan[] = [];
  for (const plan of plans) {
    let missing: string | null = null;
    for (const tool of plan.tools) if (!await runner.which(tool)) { missing = tool; break; }
    if (missing) outcomes.push({ target: plan.target, status: "not-run", reason: `${missing} was not found on PATH, so the ${plan.target} build did not run.` });
    else runnable.push(plan);
  }
  if (runnable.length === 0) return { outcomes, workDir: null, cleanup: async () => {} };
  const workDir = await mkdtemp(join(tmpdir(), "launchymind-build-"));
  await cp(projectPath, workDir, { recursive: true, filter: (source) => !SKIP.has(basename(source)) || source === projectPath });
  for (const plan of runnable) {
    const cwd = join(workDir, relative(projectPath, plan.cwd));
    const commandText = [plan.command, ...plan.args].join(" ");
    const result = await runner.run(plan.command, plan.args, cwd, timeoutMs);
    const logTail = result.output.split("\n").slice(-20).join("\n");
    if (result.code !== 0) {
      outcomes.push({ target: plan.target, status: "failed", reason: `${commandText} exited with code ${result.code}.`, command: commandText, logTail });
      continue;
    }
    const found = await plan.find(cwd);
    if (!found) {
      outcomes.push({ target: plan.target, status: "failed", reason: `${commandText} finished but no ${plan.target === "ios" ? "simulator .app" : ".apk"} was found.`, command: commandText, logTail });
      continue;
    }
    let artifactPath = found;
    if (plan.needsZip) {
      artifactPath = join(workDir, `${basename(found, ".app")}-simulator.ipa`);
      await zipApp(found, artifactPath);
    }
    outcomes.push({ target: plan.target, status: "built", reason: `${commandText} succeeded.`, command: commandText, artifactPath });
  }
  return { outcomes, workDir, cleanup: async () => { if (!options.keep) await rm(workDir, { recursive: true, force: true }); } };
}

/** One fact for the rule engine: built only when every planned build produced an artifact. */
export function buildStatus(outcomes: BuildOutcome[]): "built" | "failed" | "unknown" {
  if (outcomes.some((item) => item.status === "failed")) return "failed";
  if (outcomes.length > 0 && outcomes.every((item) => item.status === "built")) return "built";
  return "unknown";
}
