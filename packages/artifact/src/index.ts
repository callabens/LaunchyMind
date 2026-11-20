import { inflateRawSync, deflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import type { Evidence, FactValue } from "../../core/src/index.ts";

export interface ArtifactRead {
  kind: "ipa" | "apk" | "aab";
  facts: Record<string, FactValue>;
  evidence: Array<Omit<Evidence, "id">>;
  targetSdk: number | null;
  adId: boolean | null;
  tracking: "true" | "false" | null;
  cameraUsage: boolean | null;
  /** Bundle identifier or Android package name, when the manifest had one. */
  appId?: string | null;
  /** iOS NS*UsageDescription keys with text, or Android uses-permission names. */
  permissions?: string[];
}

export async function readArtifact(path: string): Promise<ArtifactRead> {
  const bytes = await readFile(path);
  const files = unzip(bytes);
  if ([...files.keys()].some((name) => name.startsWith("Payload/") && name.endsWith(".app/Info.plist"))) return readIpa(files);
  if (files.has("AndroidManifest.xml")) return readApk(files);
  if ([...files.keys()].some((name) => name.endsWith("manifest/AndroidManifest.xml"))) return readAab(files);
  throw new Error("The artifact is not an IPA, APK, or AAB that this version can read.");
}

function readIpa(files: Map<string, Buffer>): ArtifactRead {
  const infoPath = [...files.keys()].find((name) => /Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  const info = infoPath ? decodePlist(files.get(infoPath) ?? Buffer.alloc(0)) : null;
  const privacyPath = [...files.keys()].find((name) => /Payload\/[^/]+\.app\/PrivacyInfo\.xcprivacy$/.test(name));
  const privacy = privacyPath ? (files.get(privacyPath)?.toString("utf8") ?? "") : "";
  const provision = [...files.values()].find((file) => file.includes("Entitlements"))?.toString("latin1") ?? "";
  const frameworks = [...files.keys()].filter((name) => name.includes(".framework/") && name.endsWith("PrivacyInfo.xcprivacy"));
  const usage = plistString(info, "NSCameraUsageDescription");
  const tracking = privacy.includes("<key>NSPrivacyTracking</key>")
    ? (/<key>NSPrivacyTracking<\/key>\s*<true/.test(privacy) ? "true" : "false")
    : null;
  const facts: Record<string, FactValue> = {
    "artifact.present": true,
    "platform.ios": true,
    "platform.android": false,
    "ios.usage.camera": usage ? true : privacyPath ? false : "unknown",
    "ios.privacy_manifest.present": Boolean(privacyPath),
    "ios.privacy_manifest.tracking": tracking ?? "unknown",
    "framework.flutter": [...files.keys()].some((name) => name.includes("Flutter.framework/")),
  };
  const evidence: Array<Omit<Evidence, "id">> = [{
    facts: ["artifact.present", "ios.privacy_manifest.present", "ios.usage.camera"],
    kind: "file",
    detail: `IPA Info.plist ${info ? "was read" : "was not a plist this version understands"}. App privacy manifest ${privacyPath ? "was found" : "was absent"}. Framework manifests: ${frameworks.length}. Provisioning profile ${provision.includes("Entitlements") ? "contains an Entitlements plist and its signature was not checked" : "was not found"}.`,
    path: infoPath ?? "Payload",
  }];
  return {
    kind: "ipa",
    facts,
    evidence,
    targetSdk: null,
    adId: null,
    tracking,
    cameraUsage: usage ? true : privacyPath ? false : null,
    appId: plistString(info, "CFBundleIdentifier") ?? null,
    permissions: usageKeys(info),
  };
}

function readApk(files: Map<string, Buffer>): ArtifactRead {
  const manifest = files.get("AndroidManifest.xml") ?? Buffer.alloc(0);
  const xml = readBinaryXml(manifest);
  return androidArtifact("apk", xml, files);
}

function readAab(files: Map<string, Buffer>): ArtifactRead {
  const path = [...files.keys()].find((name) => name.endsWith("manifest/AndroidManifest.xml")) ?? "";
  const xml = readProtoXml(files.get(path) ?? Buffer.alloc(0));
  return androidArtifact("aab", xml, files);
}

function androidArtifact(kind: "apk" | "aab", xml: AndroidXml, files: Map<string, Buffer>): ArtifactRead {
  const adId = xml.permissions.includes("com.google.android.gms.permission.AD_ID");
  const flutter = [...files.keys()].some((name) => name.includes("libflutter.so"));
  const facts: Record<string, FactValue> = {
    "artifact.present": true,
    "platform.android": true,
    "platform.ios": false,
    "android.target_sdk": xml.targetSdk ?? "unknown",
    "android.ad_id": xml.targetSdk === null && xml.permissions.length === 0 ? "unknown" : adId ? "declared" : "missing",
    "framework.flutter": flutter,
  };
  return {
    kind,
    facts,
    evidence: [{
      facts: ["artifact.present", "android.target_sdk", "android.ad_id"],
      kind: "file",
      detail: `${kind.toUpperCase()} manifest targetSdk ${xml.targetSdk ?? "was not read"}. AD_ID ${adId ? "is declared" : xml.permissions.length ? "is not declared" : "was not read"}.`,
      path: kind === "apk" ? "AndroidManifest.xml" : "base/manifest/AndroidManifest.xml",
    }],
    targetSdk: xml.targetSdk,
    adId: xml.permissions.length || xml.targetSdk !== null ? adId : null,
    tracking: null,
    cameraUsage: null,
    appId: xml.packageName ?? null,
    permissions: xml.permissions,
  };
}

interface AndroidXml { targetSdk: number | null; permissions: string[]; packageName?: string | null }

function usageKeys(info: unknown): string[] {
  if (!info || typeof info !== "object") return [];
  return Object.entries(info as Record<string, unknown>).filter(([key, value]) => /^NS\w+UsageDescription$/.test(key) && typeof value === "string" && value.trim()).map(([key]) => key).sort();
}

export function unzip(bytes: Buffer): Map<string, Buffer> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("The file is not a zip archive.");
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30);
    const comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localName = bytes.readUInt16LE(local + 26);
    const localExtra = bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(local + 30 + localName + localExtra, local + 30 + localName + localExtra + compressed);
    files.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}

export function zipFiles(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

export function encodePlist(value: Plist): Buffer {
  const objects: Plist[] = [];
  const idOf = new Map<Plist, number>();
  const walk = (item: Plist): number => {
    if (idOf.has(item)) return idOf.get(item)!;
    const id = objects.length;
    objects.push(item);
    idOf.set(item, id);
    if (item && typeof item === "object" && !Buffer.isBuffer(item)) {
      if (Array.isArray(item)) item.forEach(walk);
      else {
        for (const [key, child] of Object.entries(item)) {
          walk(key);
          walk(child as Plist);
        }
      }
    }
    return id;
  };
  walk(value);
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  for (const item of objects) {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(encodeObject(item, idOf));
  }
  const body = Buffer.concat(parts);
  const offsetSize = 4;
  const table = Buffer.alloc(objects.length * offsetSize);
  offsets.forEach((item, index) => table.writeUInt32BE(item, index * offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(idOf.get(value) ?? 0), 16);
  trailer.writeBigUInt64BE(BigInt(8 + body.length), 24);
  return Buffer.concat([Buffer.from("bplist00"), body, table, trailer]);
}

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

function encodeObject(item: Plist, ids: Map<Plist, number>): Buffer {
  if (typeof item === "boolean") return Buffer.from([item ? 0x09 : 0x08]);
  if (typeof item === "number") {
    const body = Buffer.alloc(4);
    body.writeInt32BE(item, 0);
    return Buffer.concat([Buffer.from([0x12]), body]);
  }
  if (typeof item === "string") {
    const text = Buffer.from(item, "ascii");
    if (text.length < 15) return Buffer.concat([Buffer.from([0x50 + text.length]), text]);
    return Buffer.concat([Buffer.from([0x5f, 0x10, text.length]), text]);
  }
  if (Array.isArray(item)) {
    const refs = Buffer.from(item.map((child) => ids.get(child) ?? 0));
    return Buffer.concat([Buffer.from([0xa0 + Math.min(item.length, 14)]), item.length < 15 ? refs : Buffer.concat([Buffer.from([0x10, item.length]), refs])]);
  }
  const entries = Object.entries(item);
  const keys = Buffer.from(entries.map(([key]) => ids.get(key) ?? 0));
  const values = Buffer.from(entries.map(([, child]) => ids.get(child as Plist) ?? 0));
  const count = entries.length;
  return Buffer.concat([Buffer.from([0xd0 + Math.min(count, 14)]), count < 15 ? Buffer.concat([keys, values]) : Buffer.concat([Buffer.from([0x10, count]), keys, values])]);
}

export function decodePlist(bytes: Buffer): Plist | null {
  if (bytes.toString("ascii", 0, 8) !== "bplist00") {
    if (bytes.includes("<?xml")) return null;
    return null;
  }
  const trailer = bytes.subarray(bytes.length - 32);
  const offsetSize = trailer[6] ?? 1;
  const refSize = trailer[7] ?? 1;
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const table = Number(trailer.readBigUInt64BE(24));
  const readRef = (at: number) => readInt(bytes, at, refSize);
  const offsetOf = (id: number) => 8 + readInt(bytes, table + id * offsetSize, offsetSize);
  const readAt = (id: number): Plist => {
    let at = offsetOf(id);
    const marker = bytes[at] ?? 0;
    at += 1;
    if (marker === 0x08) return false;
    if (marker === 0x09) return true;
    const inline = marker & 0x0f;
    const size = inline === 0x0f ? readSized(bytes, at) : inline;
    if (inline === 0x0f) at += 1 + intBytes(bytes[at] ?? 0);
    if ((marker & 0xf0) === 0x10) return readInt(bytes, at, 1 << inline);
    if ((marker & 0xf0) === 0x50) return bytes.toString("ascii", at, at + size);
    if ((marker & 0xf0) === 0xa0) {
      const refs = Array.from({ length: size }, (_, index) => readRef(at + index * refSize));
      return refs.map(readAt);
    }
    if ((marker & 0xf0) === 0xd0) {
      const dict: { [key: string]: Plist } = {};
      for (let index = 0; index < size; index += 1) {
        const key = readAt(readRef(at + index * refSize));
        const value = readAt(readRef(at + (size + index) * refSize));
        if (typeof key === "string") dict[key] = value;
      }
      return dict;
    }
    return "";
  };
  try {
    return readAt(top);
  } catch {
    return null;
  }
}

function readSized(bytes: Buffer, at: number): number {
  const marker = bytes[at] ?? 0;
  return readInt(bytes, at + 1, 1 << (marker & 0x0f));
}

function intBytes(marker: number): number {
  return 1 << (marker & 0x0f);
}

function readInt(bytes: Buffer, at: number, size: number): number {
  let value = 0;
  for (let index = 0; index < size; index += 1) value = (value << 8) | (bytes[at + index] ?? 0);
  return value;
}

function plistString(value: Plist | null, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const field = value[key];
  return typeof field === "string" && field ? field : null;
}

export function encodeBinaryXml(targetSdk: number, permissions: string[]): Buffer {
  const strings = ["manifest", "uses-sdk", "uses-permission", "package", "targetSdkVersion", "android:name", String(targetSdk), "dev.example.artifact", ...permissions];
  const pool = encodeStringPool(strings);
  const manifest = startElement(0, 4, [
    attribute(3, strings.indexOf("dev.example.artifact")),
  ]);
  const sdk = startElement(1, 1, [attribute(4, 6, targetSdk)]);
  const perms = permissions.map((permission) => startElement(2, 1, [attribute(5, strings.indexOf(permission))]));
  const body = Buffer.concat([manifest, sdk, ...perms, endElement(2), endElement(1), endElement(0)]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + pool.length + body.length, 4);
  return Buffer.concat([header, pool, body]);
}

function encodeStringPool(strings: string[]): Buffer {
  const encoded = strings.map((item) => Buffer.concat([Buffer.from([item.length, 0]), Buffer.from(item, "utf16le"), Buffer.from([0, 0])]));
  const offsets = Buffer.alloc(strings.length * 4);
  let cursor = 0;
  encoded.forEach((item, index) => {
    offsets.writeUInt32LE(cursor, index * 4);
    cursor += item.length;
  });
  const header = Buffer.alloc(28);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(28, 2);
  const size = 28 + offsets.length + cursor;
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(28 + offsets.length, 20);
  return Buffer.concat([header, offsets, ...encoded]);
}

function startElement(name: number, count: number, attributes: Buffer[]): Buffer {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(36);
  header.writeUInt16LE(0x0102, 0);
  header.writeUInt16LE(16, 2);
  header.writeUInt32LE(36 + body.length, 4);
  header.writeUInt32LE(4294967295, 16);
  header.writeUInt32LE(name, 20);
  header.writeUInt16LE(36, 24);
  header.writeUInt16LE(20, 26);
  header.writeUInt16LE(count, 28);
  return Buffer.concat([header, body]);
}

function endElement(name: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt16LE(0x0103, 0);
  header.writeUInt16LE(16, 2);
  header.writeUInt32LE(24, 4);
  header.writeUInt32LE(4294967295, 16);
  header.writeUInt32LE(name, 20);
  return header;
}

function attribute(name: number, raw: number, intValue?: number): Buffer {
  const out = Buffer.alloc(20);
  out.writeUInt32LE(4294967295, 0);
  out.writeUInt32LE(name, 4);
  out.writeUInt32LE(intValue === undefined ? raw : 4294967295, 8);
  out.writeUInt16LE(8, 12);
  out[14] = intValue === undefined ? 0x03 : 0x10;
  out.writeInt32LE(intValue ?? raw, 16);
  return out;
}

export function readBinaryXml(bytes: Buffer): AndroidXml {
  const permissions: string[] = [];
  let targetSdk: number | null = null;
  let packageName: string | null = null;
  if (bytes.length < 8 || bytes.readUInt16LE(0) !== 0x0003) return { targetSdk, permissions };
  const strings = readPool(bytes.subarray(8));
  let offset = 8 + (bytes.readUInt32LE(8 + 4));
  while (offset + 8 <= bytes.length) {
    const type = bytes.readUInt16LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8) break;
    if (type === 0x0102 && offset + 36 <= bytes.length) {
      const name = strings[bytes.readUInt32LE(offset + 20)] ?? "";
      const count = bytes.readUInt16LE(offset + 28);
      for (let index = 0; index < count; index += 1) {
        const at = offset + 36 + index * 20;
        const attr = strings[bytes.readUInt32LE(at + 4)] ?? "";
        const dataType = bytes[at + 14];
        const data = bytes.readInt32LE(at + 16);
        const text = dataType === 0x03 ? (strings[data] ?? "") : String(data);
        if (name === "uses-sdk" && attr === "targetSdkVersion") targetSdk = data;
        if (name === "uses-permission" && attr === "android:name") permissions.push(text);
        if (name === "manifest" && attr === "package" && text) packageName = text;
      }
    }
    offset += size;
  }
  return { targetSdk, permissions, packageName };
}

function readPool(bytes: Buffer): string[] {
  if (bytes.readUInt16LE(0) !== 0x0001) return [];
  const count = bytes.readUInt32LE(8);
  const start = bytes.readUInt32LE(20);
  const strings: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = start + bytes.readUInt32LE(28 + index * 4);
    const length = bytes.readUInt16LE(at);
    strings.push(bytes.toString("utf16le", at + 2, at + 2 + length * 2));
  }
  return strings;
}

export function encodeProtoManifest(targetSdk: number, permissions: string[]): Buffer {
  const usesSdk = protoElement("uses-sdk", [protoAttribute("targetSdkVersion", String(targetSdk))]);
  const perms = permissions.map((permission) => protoElement("uses-permission", [protoAttribute("android:name", permission)]));
  return protoElement("manifest", [protoAttribute("package", "dev.example.artifact")], [usesSdk, ...perms]);
}

export function readProtoXml(bytes: Buffer): AndroidXml {
  const root = protoElementFields(bytes);
  const permissions: string[] = [];
  let targetSdk: number | null = null;
  let packageName: string | null = null;
  const walk = (fields: Map<number, Buffer[]>): void => {
    const name = protoString(fields.get(1)?.[0]);
    for (const attribute of fields.get(3) ?? []) {
      const attr = protoElementFields(attribute);
      const attrName = protoString(attr.get(2)?.[0]);
      const value = protoString(attr.get(3)?.[0]);
      if (name === "uses-sdk" && attrName === "targetSdkVersion") targetSdk = Number(value);
      if (name === "uses-permission" && attrName === "android:name" && value) permissions.push(value);
      if (name === "manifest" && attrName === "package" && value) packageName = value;
    }
    for (const child of fields.get(5) ?? []) walk(protoElementFields(child));
  };
  walk(root);
  return { targetSdk: Number.isFinite(targetSdk) ? targetSdk : null, permissions, packageName };
}

function protoElement(name: string, attributes: Buffer[], children: Buffer[] = []): Buffer {
  const fields = [protoBytes(1, Buffer.from(name)), ...attributes.map((item) => protoBytes(3, item)), ...children.map((item) => protoBytes(5, item))];
  return Buffer.concat(fields);
}

function protoAttribute(name: string, value: string): Buffer {
  return Buffer.concat([protoBytes(2, Buffer.from(name)), protoBytes(3, Buffer.from(value))]);
}

function protoBytes(field: number, data: Buffer): Buffer {
  return Buffer.concat([protoVarint((field << 3) | 2), protoVarint(data.length), data]);
}

function protoVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const next = rest & 0x7f;
    rest >>= 7;
    bytes.push(rest ? next | 0x80 : next);
  } while (rest);
  return Buffer.from(bytes);
}

function protoElementFields(bytes: Buffer | undefined): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>();
  if (!bytes) return fields;
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.next;
    const field = tag.value >> 3;
    const wire = tag.value & 7;
    if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.next;
      const data = bytes.subarray(offset, offset + length.value);
      offset += length.value;
      const list = fields.get(field) ?? [];
      list.push(data);
      fields.set(field, list);
    } else if (wire === 0) {
      const value = readVarint(bytes, offset);
      offset = value.next;
    } else break;
  }
  return fields;
}

function protoString(bytes: Buffer | undefined): string {
  return bytes ? bytes.toString("utf8") : "";
}

function readVarint(bytes: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor] ?? 0;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: cursor };
}
