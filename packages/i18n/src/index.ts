import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * User-facing interface strings. Rule sources are quoted in their original
 * language and are never translated. Store names such as App Store Connect,
 * Play Console, App Privacy, and Data safety stay as the stores write them.
 */
export const LOCALES = ["en", "tr", "de", "fr", "es", "pt-BR", "it", "ja", "ko", "zh-Hans", "ar", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const RTL_LOCALES: ReadonlySet<Locale> = new Set(["ar"]);

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

/** Map a tag like "pt_BR.UTF-8", "zh-CN", "de-AT", or "ja" onto a supported locale. */
export function matchLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const clean = tag.split(".")[0]?.split("@")[0]?.replace(/_/g, "-").trim() ?? "";
  if (!clean || clean === "C" || clean === "POSIX") return null;
  const lower = clean.toLowerCase();
  const exact = LOCALES.find((item) => item.toLowerCase() === lower);
  if (exact) return exact;
  const [language, ...rest] = lower.split("-");
  if (language === "pt") return "pt-BR";
  if (language === "zh") {
    // Traditional Chinese is not shipped; do not show Simplified to a zh-TW or zh-Hant user by guess.
    if (rest.some((part) => part === "hant" || part === "tw" || part === "hk" || part === "mo")) return null;
    return "zh-Hans";
  }
  return LOCALES.find((item) => item === language) ?? null;
}

/**
 * --lang wins. Otherwise the first set of LC_ALL, LC_MESSAGES, LANG decides.
 * When none is set, the VS Code display language (VSCODE_NLS_CONFIG) is used,
 * then English.
 */
export function detectLocale(env: Record<string, string | undefined> = process.env, explicit?: string | null): Locale {
  if (explicit) {
    const chosen = matchLocale(explicit);
    if (!chosen) throw new UnsupportedLocaleError(explicit);
    return chosen;
  }
  // POSIX order: the first of these that is set decides. C, POSIX, or an unsupported language means English.
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[key];
    if (value) return matchLocale(value) ?? DEFAULT_LOCALE;
  }
  const nls = env.VSCODE_NLS_CONFIG;
  if (nls) {
    try {
      const parsed = JSON.parse(nls) as { locale?: unknown };
      const found = typeof parsed.locale === "string" ? matchLocale(parsed.locale) : null;
      if (found) return found;
    } catch {
      // Not JSON; ignore.
    }
  }
  return DEFAULT_LOCALE;
}

export class UnsupportedLocaleError extends Error {
  readonly requested: string;
  constructor(requested: string) {
    super(`Unsupported language ${requested}. Supported: ${LOCALES.join(", ")}.`);
    this.requested = requested;
  }
}

export type Catalog = Record<string, string>;

export function findI18nDir(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "packages", "packs", "i18n");
    if (existsSync(join(candidate, "ui", "en.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("LaunchyMind locale catalogs were not found. Expected packages/packs/i18n/ui/en.json.");
}

const cache = new Map<Locale, Catalog>();

export function loadCatalog(locale: Locale): Catalog {
  const cached = cache.get(locale);
  if (cached) return cached;
  const catalog = JSON.parse(readFileSync(join(findI18nDir(), "ui", `${locale}.json`), "utf8")) as Catalog;
  cache.set(locale, catalog);
  return catalog;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A missing key falls back to English, then to the key itself. */
export function translator(locale: Locale): Translate {
  const catalog = loadCatalog(locale);
  const english = loadCatalog(DEFAULT_LOCALE);
  return (key, vars = {}) => {
    const template = catalog[key] ?? english[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
  };
}

export interface LocalizedText { text: string; locale: Locale; fallback: boolean }

/** Pick a rule explanation in the locale, or English with fallback=true. */
export function pickText(texts: Partial<Record<string, string | null | undefined>>, locale: Locale): LocalizedText | null {
  const own = texts[locale];
  if (own) return { text: own, locale, fallback: false };
  const english = texts.en;
  if (english) return { text: english, locale: "en", fallback: locale !== "en" };
  return null;
}
