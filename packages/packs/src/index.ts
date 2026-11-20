import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
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
