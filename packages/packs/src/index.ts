import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { packMetaSchema } from "../../core/src/index.ts";
import { loadPack, type LoadedPack } from "../../rules/src/index.ts";

const ALLOWED_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".md", ".txt"]);
const ALLOWED_NAMES = new Set(["license", "notice", "readme", "readme.md"]);

export interface InstalledPack {
  id: string;
  name: string;
  version: string;
  directory: string;
}

export function projectPackRoot(projectPath: string): string {
  return join(resolve(projectPath), ".launchymind", "packs");
}

export async function listInstalledPacks(projectPath: string): Promise<InstalledPack[]> {
  const root = projectPackRoot(projectPath);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const packs: InstalledPack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(root, entry.name);
    const text = await readFile(join(directory, "pack.yaml"), "utf8").catch(() => "");
    const meta = packMetaSchema.safeParse(text ? parse(text) : null);
    if (!meta.success) continue;
    packs.push({ id: meta.data.id, name: meta.data.name, version: meta.data.version, directory });
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadProjectPacks(projectPath: string): Promise<{ packs: LoadedPack[]; problems: string[] }> {
  const root = projectPackRoot(projectPath);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const packs: LoadedPack[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(root, entry.name);
    const executable = await findNonDataFile(directory);
    if (executable) {
      problems.push(`Project pack ${entry.name} was not loaded because it contains ${executable}, which is not data.`);
      continue;
    }
    try {
      packs.push(await loadPack(directory));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`Project pack ${entry.name} was not loaded: ${message}`);
    }
  }
  return { packs, problems };
}

const registryEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(10),
  repository: z.string().min(1),
  path: z.string().regex(/^registry\/packs\/[a-z0-9-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const registrySchema = z.object({
  schema: z.literal(1),
  packs: z.array(registryEntrySchema),
}).strict();

export type RegistryFile = z.infer<typeof registrySchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

export function findRegistryPath(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "registry", "index.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("The pack registry was not found at registry/index.json.");
}

export async function loadRegistry(path = findRegistryPath()): Promise<RegistryFile> {
  const parsed = registrySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`The pack registry is not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function searchRegistry(index: RegistryFile, query: string): RegistryEntry[] {
  const needle = query.trim().toLowerCase();
  return index.packs.filter((pack) => pack.name.includes(needle) || pack.description.toLowerCase().includes(needle));
}

export async function packIntegrity(directory: string): Promise<string> {
  const files = (await walkFiles(directory)).filter((file) => isDataFile(basename(file))).sort((a, b) => relative(directory, a).localeCompare(relative(directory, b)));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(directory, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function addPackByName(projectPath: string, name: string, registryPath = findRegistryPath()): Promise<InstalledPack> {
  const index = await loadRegistry(registryPath);
  const entry = index.packs.find((pack) => pack.name === name);
  if (!entry) throw new Error(`No pack named ${name} is in the registry. Try launchymind pack search.`);
  const repoRoot = dirname(dirname(registryPath));
  const material = await materializeCommit(entry, repoRoot);
  try {
    const actual = await packIntegrity(material.directory);
    if (actual !== entry.integrity) {
      throw new Error(`The files for ${name} at ${entry.commit} do not match the registry integrity hash. Nothing was installed.`);
    }
    return await addPack(projectPath, material.directory);
  } finally {
    if (material.worktree) spawnSync("git", ["-C", material.worktree, "worktree", "remove", "--force", material.checkout ?? ""], { encoding: "utf8" });
    if (material.cleanup) await rm(material.cleanup, { recursive: true, force: true });
  }
}

export async function addPack(projectPath: string, source: string): Promise<InstalledPack> {
  const material = await materialize(source);
  try {
    const executable = await findNonDataFile(material.directory);
    if (executable) {
      throw new Error(`Refusing to install ${source}. It contains ${executable}. Packs are data only (yaml, json, markdown, and license text).`);
    }
    const loaded = await loadPack(material.directory);
    const destination = join(projectPackRoot(projectPath), loaded.meta.id);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await copyDataFiles(material.directory, destination);
    return { id: loaded.meta.id, name: loaded.meta.name, version: loaded.meta.version, directory: destination };
  } finally {
    if (material.cleanup) await rm(material.cleanup, { recursive: true, force: true });
  }
}

export async function removePack(projectPath: string, id: string): Promise<void> {
  if (!/^[a-z0-9.-]+$/.test(id)) throw new Error(`Refusing to remove ${id}. Pack ids are letters, numbers, dots, and dashes.`);
  const directory = join(projectPackRoot(projectPath), id);
  const root = projectPackRoot(projectPath);
  const back = relative(root, directory);
  if (back.startsWith("..") || isAbsolute(back)) throw new Error(`Refusing to remove outside the project pack folder.`);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`No installed pack named ${id}.`);
  await rm(directory, { recursive: true, force: true });
}

async function materialize(source: string): Promise<{ directory: string; cleanup: string | null }> {
  if (isGitUrl(source)) {
    const parent = join(tmpdir(), `launchymind-pack-${Date.now()}`);
    await mkdir(parent, { recursive: true });
    const directory = join(parent, "pack");
    const cloned = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--no-tags", "--", source, directory], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (cloned.status !== 0) {
      await rm(parent, { recursive: true, force: true });
      throw new Error(`Could not clone ${source}. ${((cloned.stderr || cloned.stdout) ?? "").trim()}`.trim());
    }
    return { directory, cleanup: parent };
  }
  const directory = resolve(source);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Pack source is not a directory or a git URL: ${source}`);
  return { directory, cleanup: null };
}

async function materializeCommit(entry: RegistryEntry, repoRoot: string): Promise<{ directory: string; cleanup: string | null; worktree: string | null; checkout: string | null }> {
  if (entry.path.split("/").includes("..")) throw new Error(`Refusing registry path ${entry.path}.`);
  const local = spawnSync("git", ["-C", repoRoot, "cat-file", "-t", entry.commit], { encoding: "utf8" });
  const parent = join(tmpdir(), `launchymind-registry-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  const checkout = join(parent, "tree");
  if (local.status === 0 && local.stdout.trim() === "commit") {
    const added = spawnSync("git", ["-C", repoRoot, "worktree", "add", "--detach", checkout, entry.commit], { encoding: "utf8" });
    if (added.status !== 0) {
      await rm(parent, { recursive: true, force: true });
      throw new Error(`Could not read commit ${entry.commit}. ${added.stderr.trim()}`.trim());
    }
    return { directory: join(checkout, entry.path), cleanup: parent, worktree: repoRoot, checkout };
  }
  const cloned = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-tags", "--", entry.repository, checkout], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (cloned.status !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`Could not clone ${entry.repository}. ${cloned.stderr.trim()}`.trim());
  }
  const checked = spawnSync("git", ["-C", checkout, "checkout", "--detach", entry.commit], { encoding: "utf8" });
  if (checked.status !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`Commit ${entry.commit} is not in ${entry.repository}. Nothing was installed.`);
  }
  return { directory: join(checkout, entry.path), cleanup: parent, worktree: null, checkout: null };
}

function isGitUrl(source: string): boolean {
  return source.startsWith("https://") || source.startsWith("ssh://") || source.startsWith("git@");
}

async function findNonDataFile(directory: string): Promise<string | null> {
  const files = await walkFiles(directory);
  for (const file of files) {
    const name = basename(file);
    if (!isDataFile(name)) return relative(directory, file);
    const text = await readFile(file).catch(() => null);
    if (text && text.subarray(0, 2).toString("utf8") === "#!") return relative(directory, file);
  }
  return null;
}

function isDataFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (ALLOWED_NAMES.has(lower)) return true;
  return ALLOWED_EXTENSIONS.has(extname(lower));
}

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = join(directory, entry.name);
    if (entry.name === "node_modules") {
      files.push(full);
      continue;
    }
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function copyDataFiles(source: string, destination: string): Promise<void> {
  const files = await walkFiles(source);
  for (const file of files) {
    const rel = relative(source, file);
    if (!isDataFile(basename(file))) continue;
    const target = join(destination, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await cp(file, target);
  }
}
