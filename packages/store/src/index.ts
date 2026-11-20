import { deflateSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Evidence, FactValue } from "../../core/src/index.ts";

export interface StoreRead {
  facts: Record<string, FactValue>;
  evidence: Array<Omit<Evidence, "id">>;
  urls: string[];
}

const IOS_OTHER = /\b(android|google play|windows phone)\b/i;
const PLAY_OTHER = /\b(iphone|ipad|ios|app store|apple watch)\b/i;
const PLACEHOLDER = /\b(lorem ipsum|todo|tbd|placeholder|your text here)\b/i;
const FUTURE = /\b(coming soon|will be added|available soon|yakında|gelecek sürüm)\b/i;
const PRICE = /(?:\$|€|£|₺)\s?\d|\b\d+\s?%\s?off\b|\bfree for a limited time\b/i;
const TITLE_DEAL = /\b(free|no ads)\b/i;
const COMPETITORS = ["facebook", "instagram", "whatsapp", "tiktok", "snapchat", "spotify", "netflix", "youtube"];
const FEATURES: Array<[string, string]> = [
  ["subscription", "abonelik"],
  ["account", "hesap"],
  ["camera", "kamera"],
  ["location", "konum"],
  ["ads", "reklam"],
  ["offline", "çevrimdışı"],
  ["notification", "bildirim"],
];

const REQUIRED_IPHONE = new Set(["1179x2556", "2556x1179", "1206x2622", "2622x1206"]);
const APPLE_SCREENSHOTS = new Set<string>([
  ...REQUIRED_IPHONE,
  "1398x2034", "2034x1398", "2007x2853", "2853x2007",
  "1260x2736", "2736x1260", "1290x2796", "2796x1290", "1320x2868", "2868x1320",
  "1284x2778", "2778x1284", "1242x2688", "2688x1242",
  "1170x2532", "2532x1170", "1125x2436", "2436x1125", "1080x2340", "2340x1080",
  "1242x2208", "2208x1242", "750x1334", "1334x750",
  "640x1096", "640x1136", "1136x600", "1136x640", "640x920", "640x960", "960x600", "960x640",
  "2064x2752", "2752x2064", "2048x2732", "2732x2048",
  "1488x2266", "2266x1488", "1512x2316", "2316x1512", "1668x2420", "2420x1668", "1668x2388", "2388x1668", "1640x2360", "2360x1640",
  "1668x2224", "2224x1668",
  "1536x2008", "1536x2048", "2048x1496", "2048x1536", "768x1004", "768x1024", "1024x748", "1024x768",
]);

export async function readStore(root: string, now = new Date()): Promise<StoreRead> {
  const facts = blankStoreFacts();
  const evidence: Array<Omit<Evidence, "id">> = [];
  const ios = await readTree(root, [
    ".launchymind/store/ios",
    "fastlane/metadata/ios",
  ]);
  const android = await readTree(root, [
    ".launchymind/store/android",
    "fastlane/metadata/android",
  ]);
  const iosPresent = ios.files.length > 0;
  const androidPresent = android.files.length > 0;
  facts["store.ios.present"] = iosPresent;
  facts["store.android.present"] = androidPresent;
  if (!iosPresent && !androidPresent) return { facts, evidence, urls: [] };

  const iosText = texts(ios, ["name", "subtitle", "description", "keywords", "promotional_text", "promo", "release_notes", "release-notes"]);
  const playText = texts(android, ["title", "short_description", "short-description", "full_description", "full-description"]);
  facts["store.ios.name"] = fieldLength(ios, ["name"], 30, 2);
  facts["store.ios.subtitle"] = optionalLength(ios, ["subtitle"], 30);
  facts["store.ios.description"] = fieldLength(ios, ["description"], 4000, 1);
  facts["store.ios.keywords"] = keywordBytes(ios);
  facts["store.ios.promo"] = optionalLength(ios, ["promotional_text", "promo"], 170);
  facts["store.ios.release_notes"] = optionalLength(ios, ["release_notes", "release-notes"], 4000);
  facts["store.android.title"] = fieldLength(android, ["title"], 30, 1);
  facts["store.android.short_description"] = fieldLength(android, ["short_description", "short-description"], 80, 1);
  facts["store.android.full_description"] = fieldLength(android, ["full_description", "full-description"], 4000, 1);

  const listing = [...iosText, ...playText];
  facts["store.text.placeholder"] = listing.length === 0 ? "not-applicable" : listing.some((item) => PLACEHOLDER.test(item.text)) ? "yes" : "no";
  facts["store.ios.other_platform"] = iosText.length === 0 ? "not-applicable" : iosText.some((item) => IOS_OTHER.test(item.text)) ? "yes" : "no";
  facts["store.android.other_platform"] = playText.length === 0 ? "not-applicable" : playText.some((item) => PLAY_OTHER.test(item.text)) ? "yes" : "no";
  const promiseFields = [...iosText, ...playText].filter((item) => !/promo/.test(item.name));
  facts["store.text.future_promise"] = promiseFields.length === 0 ? "not-applicable" : promiseFields.some((item) => FUTURE.test(item.text)) ? "yes" : "no";
  facts["store.copyright.year"] = copyrightYear([...ios.files, ...android.files], now);
  facts["store.text.price"] = priceClaim(iosText, playText);
  facts["store.keywords.stuffing"] = keywordStuffing(ios);
  facts["store.locale.features"] = localeFeatures(iosText, playText);

  const iosIcon = await firstImage(root, ios.files, ["icon.png", "app_icon.png"]);
  const playIcon = await firstImage(root, android.files, ["icon.png"]);
  const feature = await firstImage(root, android.files, ["feature-graphic.png", "featuregraphic.png"]);
  facts["store.ios.icon"] = iosPresent ? await iconFact(iosIcon, 1024, 1024, false) : "not-applicable";
  facts["store.android.icon"] = androidPresent ? await iconFact(playIcon, 512, 512, true) : "not-applicable";
  facts["store.android.feature_graphic"] = androidPresent ? await iconFact(feature, 1024, 500, false) : "not-applicable";
  facts["store.ios.screenshots"] = iosPresent ? await appleShots(imageFiles(root, ios.files, ["screenshots", "iphone"])) : "not-applicable";
  facts["store.android.screenshots"] = androidPresent ? await playShots(imageFiles(root, android.files, ["screenshots", "phonescreenshots"])) : "not-applicable";

  const urls = uniqueUrls([...ios.files, ...android.files]);
  facts["store.urls.status"] = urls.length === 0 ? "not-applicable" : "unknown";
  evidence.push({
    facts: ["store.ios.present", "store.android.present"],
    kind: "file",
    detail: `Store text files: iOS ${ios.files.length}, Play ${android.files.length}. Fastlane metadata and .launchymind/store were both read.`,
    path: ios.files[0]?.path ?? android.files[0]?.path ?? ".launchymind/store",
  });
  return { facts, evidence, urls };
}

function blankStoreFacts(): Record<string, FactValue> {
  return {
    "store.ios.present": false,
    "store.android.present": false,
    "store.ios.name": "not-applicable",
    "store.ios.subtitle": "not-applicable",
    "store.ios.description": "not-applicable",
    "store.ios.keywords": "not-applicable",
    "store.ios.promo": "not-applicable",
    "store.ios.release_notes": "not-applicable",
    "store.android.title": "not-applicable",
    "store.android.short_description": "not-applicable",
    "store.android.full_description": "not-applicable",
    "store.text.placeholder": "not-applicable",
    "store.ios.other_platform": "not-applicable",
    "store.android.other_platform": "not-applicable",
    "store.text.future_promise": "not-applicable",
    "store.copyright.year": "not-applicable",
    "store.text.price": "not-applicable",
    "store.keywords.stuffing": "not-applicable",
    "store.locale.features": "not-applicable",
    "store.ios.icon": "not-applicable",
    "store.ios.screenshots": "not-applicable",
    "store.android.icon": "not-applicable",
    "store.android.feature_graphic": "not-applicable",
    "store.android.screenshots": "not-applicable",
    "store.urls.status": "not-applicable",
  };
}

interface TextFile { path: string; name: string; locale: string; text: string }

async function readTree(root: string, relatives: string[]): Promise<{ files: TextFile[] }> {
  const files: TextFile[] = [];
  for (const relativePath of relatives) {
    const absolute = join(root, relativePath);
    const found = await walk(absolute);
    for (const file of found) {
      if (!/\.(txt|md)$/i.test(file) && !/\.(png|jpe?g)$/i.test(file)) continue;
      const rel = relative(root, file).split(sep).join("/");
      const locale = localeOf(rel);
      let text = "";
      if (/\.(txt|md)$/i.test(file)) text = await readFile(file, "utf8").catch(() => "");
      files.push({ path: rel, name: file.split(sep).pop()?.toLowerCase() ?? "", locale, text });
    }
  }
  return { files };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function localeOf(path: string): string {
  const parts = path.split("/");
  const code = parts.find((part) => /^(en|tr)([-_][a-z]{2})?$/i.test(part));
  return code ? code.toLowerCase() : "";
}

function texts(tree: { files: TextFile[] }, names: string[]): TextFile[] {
  const wanted = new Set(names.map((name) => `${name}.txt`));
  return tree.files.filter((file) => wanted.has(file.name));
}

function fieldLength(tree: { files: TextFile[] }, names: string[], max: number, min: number): FactValue {
  const found = texts(tree, names);
  if (found.length === 0) return tree.files.length === 0 ? "not-applicable" : "missing";
  const worst = found.map((file) => measure(file.text, max, min));
  if (worst.includes("over")) return "over";
  if (worst.includes("under-min")) return "under-min";
  if (worst.every((item) => item === "missing")) return "missing";
  return "ok";
}

function optionalLength(tree: { files: TextFile[] }, names: string[], max: number): FactValue {
  const found = texts(tree, names);
  if (found.length === 0) return "not-applicable";
  return found.some((file) => measure(file.text, max, 0) === "over") ? "over" : "ok";
}

function measure(text: string, max: number, min: number): "ok" | "over" | "under-min" | "missing" {
  const count = Array.from(text.trim()).length;
  if (count === 0) return "missing";
  if (count < min) return "under-min";
  if (count > max) return "over";
  return "ok";
}

function keywordBytes(tree: { files: TextFile[] }): FactValue {
  const found = texts(tree, ["keywords"]);
  if (found.length === 0) return tree.files.length === 0 ? "not-applicable" : "missing";
  const bytes = Buffer.byteLength(found.map((file) => file.text.trim()).join("\n"), "utf8");
  if (bytes === 0) return "missing";
  return bytes > 100 ? "over" : "ok";
}

function copyrightYear(files: TextFile[], now: Date): FactValue {
  const years: number[] = [];
  for (const file of files) {
    const named = file.name.includes("copyright");
    if (!named && !/copyright|©|\(c\)/i.test(file.text)) continue;
    const source = named ? file.text : (file.text.match(/.*(?:copyright|©|\(c\)).*/i)?.[0] ?? "");
    const match = source.match(/(\d{4})/);
    if (match?.[1]) years.push(Number(match[1]));
  }
  if (years.length === 0) return files.length === 0 ? "not-applicable" : "unknown";
  return years.some((year) => year > now.getUTCFullYear()) ? "future" : "ok";
}

function priceClaim(ios: TextFile[], play: TextFile[]): FactValue {
  const all = [...ios, ...play];
  if (all.length === 0) return "not-applicable";
  const titled = all.filter((file) => file.name === "name.txt" || file.name === "title.txt");
  if (all.some((file) => PRICE.test(file.text)) || titled.some((file) => TITLE_DEAL.test(file.text))) return "yes";
  return "no";
}

function keywordStuffing(tree: { files: TextFile[] }): FactValue {
  const found = texts(tree, ["keywords"]);
  if (found.length === 0) return "not-applicable";
  for (const file of found) {
    const tokens = file.text.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token) || COMPETITORS.some((name) => token.includes(name))) return "yes";
      seen.add(token);
    }
  }
  return "no";
}

function localeFeatures(ios: TextFile[], play: TextFile[]): FactValue {
  const descriptions = [...ios, ...play].filter((file) => /description|full_description|full-description/.test(file.name));
  const en = descriptions.filter((file) => file.locale.startsWith("en")).map((file) => file.text.toLocaleLowerCase("en")).join("\n");
  const tr = descriptions.filter((file) => file.locale.startsWith("tr")).map((file) => file.text.toLocaleLowerCase("tr")).join("\n");
  if (!en && !tr) return "not-applicable";
  if (!en || !tr) return "incomplete";
  for (const [english, turkish] of FEATURES) {
    const enHas = en.includes(english);
    const trHas = tr.includes(turkish) || tr.includes(english);
    if (enHas !== trHas) return "differ";
  }
  return "match";
}

function imageFiles(root: string, files: TextFile[], hints: string[]): string[] {
  return files
    .filter((file) => /\.(png|jpe?g)$/i.test(file.name) && hints.some((hint) => file.path.toLowerCase().includes(hint)) && !/icon|feature/.test(file.name))
    .map((file) => join(root, file.path));
}

async function firstImage(root: string, files: TextFile[], names: string[]): Promise<string | null> {
  const found = files.find((file) => names.includes(file.name) && !file.path.toLowerCase().includes("screenshot"));
  return found ? join(root, found.path) : null;
}

async function iconFact(path: string | null, width: number, height: number, wantAlpha: boolean): Promise<FactValue> {
  if (!path) return "missing";
  const image = await readImage(path);
  if (!image) return "unknown";
  if (image.width !== width || image.height !== height) return "bad";
  if (image.alpha !== wantAlpha) return "bad";
  return "ok";
}

async function appleShots(paths: string[]): Promise<FactValue> {
  if (paths.length === 0) return "missing";
  const images = [];
  for (const path of paths) {
    const image = await readImage(path);
    if (!image) return "unknown";
    images.push(image);
  }
  if (images.some((image) => !APPLE_SCREENSHOTS.has(`${image.width}x${image.height}`))) return "unknown";
  if (images.some((image) => image.alpha)) return "bad";
  const counts = new Map<string, number>();
  for (const image of images) {
    const key = `${image.width}x${image.height}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count > 10)) return "bad";
  return images.some((image) => REQUIRED_IPHONE.has(`${image.width}x${image.height}`)) ? "ok" : "bad";
}

async function playShots(paths: string[]): Promise<FactValue> {
  if (paths.length === 0) return "missing";
  const images = [];
  for (const path of paths) {
    const image = await readImage(path);
    if (!image) return "unknown";
    images.push(image);
  }
  if (images.length < 2 || images.length > 8) return "bad";
  for (const image of images) {
    const long = Math.max(image.width, image.height);
    const short = Math.min(image.width, image.height);
    if (short < 320 || long > 3840 || long > short * 2 || image.alpha) return "bad";
  }
  return "ok";
}

function uniqueUrls(files: TextFile[]): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    for (const match of file.text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const url = match[0]?.replace(/[.,;]+$/, "");
      if (url) urls.add(url);
    }
  }
  return [...urls].slice(0, 8);
}

interface ImageInfo { width: number; height: number; alpha: boolean }

async function readImage(path: string): Promise<ImageInfo | null> {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return readPng(bytes);
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  return null;
}

function readPng(bytes: Buffer): ImageInfo | null {
  let offset = 8;
  let width = 0;
  let height = 0;
  let color = 0;
  let alpha = false;
  let sawHeader = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR" && data.length >= 10) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      color = data[9] ?? 0;
      alpha = color === 4 || color === 6;
      sawHeader = width > 0 && height > 0;
    }
    if (type === "tRNS") alpha = true;
    if (type === "IEND") break;
    offset += 12 + length;
  }
  return sawHeader ? { width, height, alpha } : null;
}

function readJpeg(bytes: Buffer): ImageInfo | null {
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
      if (offset + 9 >= bytes.length) return null;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7), alpha: false };
    }
    offset += 2 + length;
  }
  return null;
}

export function syntheticPng(width: number, height: number, withAlpha: boolean): Buffer {
  const channels = withAlpha ? 4 : 3;
  const row = width * channels + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = y * row + 1 + x * channels;
      raw[index] = 12;
      raw[index + 1] = 34;
      raw[index + 2] = 56;
      if (withAlpha) raw[index + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = withAlpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
  return out;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) | 0;
}
