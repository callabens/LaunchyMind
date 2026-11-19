export type LiveStatus = "ok" | "http-error" | "missing" | "unreachable" | "placeholder" | "skipped" | "unsupported" | "not-applicable" | "unknown";

export interface LivePage {
  url: string;
  status: LiveStatus;
  httpStatus: number | null;
  placeholder: boolean;
  text: string;
  error: string | null;
}

export interface LiveChecker {
  check(url: string): Promise<LivePage>;
}

export interface PageSignals {
  collection: "yes" | "no" | "unknown";
  deletion: "yes" | "no" | "unknown";
  consent: "yes" | "no" | "unknown";
  ads: "yes" | "no" | "unknown";
  controller: "yes" | "no" | "unknown";
  purpose: "yes" | "no" | "unknown";
  transfer: "yes" | "no" | "unknown";
  legalBasis: "yes" | "no" | "unknown";
  rights: "yes" | "no" | "unknown";
  contact: "yes" | "no" | "unknown";
  mentionsName: "yes" | "no" | "unknown";
}

const PLACEHOLDER = [/lorem ipsum/i, /coming soon/i, /\btodo\b/i, /placeholder/i, /under construction/i, /this is a sample/i];

const SIGNALS: Record<Exclude<keyof PageSignals, "mentionsName">, RegExp[]> = {
  collection: [/we collect/i, /data we collect/i, /information we collect/i, /personal data/i, /kişisel veriler/i],
  deletion: [/delet/i, /retention/i, /silme/i, /silin/i],
  consent: [/withdraw consent/i, /revoke consent/i, /opt-out/i, /opt out/i, /r[ıi]zay[ıi] geri/i, /geri çek/i],
  ads: [/advertis/i, /admob/i, /reklam/i],
  controller: [/data controller/i, /veri sorumlusu/i],
  purpose: [/purpose/i, /\bamaç\b/i],
  transfer: [/recipient/i, /third part/i, /aktar/i, /\bshare\b/i],
  legalBasis: [/legal basis/i, /hukuki sebep/i],
  rights: [/your rights/i, /haklar/i, /article 11/i, /madde 11/i],
  contact: [/@/, /mailto:/i, /\bcontact\b/i, /destek/i, /iletişim/i],
};

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikePlaceholder(text: string): boolean {
  return PLACEHOLDER.some((pattern) => pattern.test(text));
}

function yesNo(text: string, patterns: RegExp[]): "yes" | "no" {
  return patterns.some((pattern) => pattern.test(text)) ? "yes" : "no";
}

export function pageSignals(text: string, names: string[]): PageSignals {
  const cleaned = text.trim();
  if (!cleaned) {
    return {
      collection: "unknown",
      deletion: "unknown",
      consent: "unknown",
      ads: "unknown",
      controller: "unknown",
      purpose: "unknown",
      transfer: "unknown",
      legalBasis: "unknown",
      rights: "unknown",
      contact: "unknown",
      mentionsName: "unknown",
    };
  }
  const lower = cleaned.toLowerCase();
  const usefulNames = names.map((name) => name.trim().toLowerCase()).filter((name) => name.length >= 3);
  return {
    collection: yesNo(cleaned, SIGNALS.collection),
    deletion: yesNo(cleaned, SIGNALS.deletion),
    consent: yesNo(cleaned, SIGNALS.consent),
    ads: yesNo(cleaned, SIGNALS.ads),
    controller: yesNo(cleaned, SIGNALS.controller),
    purpose: yesNo(cleaned, SIGNALS.purpose),
    transfer: yesNo(cleaned, SIGNALS.transfer),
    legalBasis: yesNo(cleaned, SIGNALS.legalBasis),
    rights: yesNo(cleaned, SIGNALS.rights),
    contact: yesNo(cleaned, SIGNALS.contact),
    mentionsName: usefulNames.length === 0 ? "unknown" : usefulNames.some((name) => lower.includes(name)) ? "yes" : "no",
  };
}

export function sanitizeHttpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export function appAdsUrl(website: string): string | null {
  const clean = sanitizeHttpUrl(website);
  if (!clean) return null;
  const url = new URL(clean);
  url.pathname = "/app-ads.txt";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function offlineChecker(): LiveChecker {
  return {
    async check(url: string): Promise<LivePage> {
      return { url, status: "skipped", httpStatus: null, placeholder: false, text: "", error: null };
    },
  };
}

export function scriptedChecker(pages: Record<string, { status: number; body: string }>): LiveChecker {
  return {
    async check(url: string): Promise<LivePage> {
      const clean = sanitizeHttpUrl(url);
      const scripted = clean ? pages[clean] ?? pages[url] : undefined;
      if (!scripted) {
        return { url, status: "unreachable", httpStatus: null, placeholder: false, text: "", error: "No scripted response." };
      }
      return pageFromHttp(url, scripted.status, scripted.body);
    },
  };
}

export function pageFromHttp(url: string, httpStatus: number, body: string): LivePage {
  const text = htmlToText(body).slice(0, 20_000);
  if (httpStatus === 404) {
    return { url, status: "missing", httpStatus, placeholder: false, text, error: null };
  }
  if (httpStatus < 200 || httpStatus >= 400) {
    return { url, status: "http-error", httpStatus, placeholder: false, text, error: null };
  }
  const placeholder = looksLikePlaceholder(text);
  return { url, status: placeholder ? "placeholder" : "ok", httpStatus, placeholder, text, error: null };
}

export function createNetworkChecker(fetchImpl: typeof fetch = fetch, timeoutMs = 8000): LiveChecker {
  return {
    async check(url: string): Promise<LivePage> {
      const clean = sanitizeHttpUrl(url);
      if (!clean) {
        return { url, status: "unsupported", httpStatus: null, placeholder: false, text: "", error: "Only http and https URLs are fetched." };
      }
      try {
        const response = await fetchImpl(clean, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: "text/html, text/plain, */*;q=0.8",
            "user-agent": "LaunchyMind/0.1 (+https://github.com/callabens/LaunchyMind; link-check)",
          },
        });
        const body = await readLimited(response, 1_000_000);
        return pageFromHttp(clean, response.status, body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { url: clean, status: "unreachable", httpStatus: null, placeholder: false, text: "", error: message };
      }
    },
  };
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value) continue;
    received += step.value.byteLength;
    chunks.push(step.value);
  }
  try {
    await reader.cancel();
  } catch {
    // The body may already be finished.
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged.subarray(0, maxBytes));
}
