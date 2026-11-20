import type { Evidence, FactValue } from "../../core/src/index.ts";

/** Read-only RevenueCat REST API v2 client. Only GET requests are made. The key is never logged. */
export const REVENUECAT_API = "https://api.revenuecat.com/v2";

export interface RevenueCatConfig {
  apiKey: string;
  projectId: string | null;
}

export type RevenueCatStatus = "off" | "skipped" | "unknown" | "match" | "configured" | "mismatch" | "incomplete";

export interface RevenueCatReport {
  status: RevenueCatStatus;
  facts: Record<string, FactValue>;
  evidence: Array<Omit<Evidence, "id">>;
  lines: string[];
  products: string[];
  entitlements: number;
  offerings: number;
  missingInRevenueCat: string[];
}

export function readRevenueCatConfig(env: Record<string, string | undefined>): RevenueCatConfig | null {
  const apiKey = env.REVENUECAT_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  return { apiKey, projectId: env.REVENUECAT_PROJECT_ID?.trim() || null };
}

function report(status: RevenueCatStatus, lines: string[], extra: Partial<RevenueCatReport> = {}): RevenueCatReport {
  return {
    status,
    facts: { "connect.revenuecat": status === "skipped" ? "unknown" : status },
    evidence: [],
    lines,
    products: [],
    entitlements: 0,
    offerings: 0,
    missingInRevenueCat: [],
    ...extra,
  };
}

export async function readRevenueCat(
  config: RevenueCatConfig | null,
  codeProductIds: readonly string[],
  fetchImpl: typeof fetch,
  offline: boolean,
): Promise<RevenueCatReport> {
  if (!config) return report("off", ["RevenueCat was not read. Set REVENUECAT_API_KEY (a v2 secret key with read-only project configuration permissions) to compare products. Do not commit it."]);
  if (offline) return report("skipped", ["RevenueCat is configured and was not called because the scan is offline. The product check stays unchecked."]);
  try {
    const get = async (path: string): Promise<Record<string, unknown>> => {
      const response = await fetchImpl(path.startsWith("http") ? path : `${REVENUECAT_API}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`RevenueCat returned HTTP ${response.status} for ${path.replace(/\?.*$/, "")}.`);
      const body = await response.json() as unknown;
      if (!body || typeof body !== "object") throw new Error("RevenueCat did not return a JSON object.");
      return body as Record<string, unknown>;
    };
    const list = async (path: string): Promise<Array<Record<string, unknown>>> => {
      const items: Array<Record<string, unknown>> = [];
      let next: string | null = `${path}${path.includes("?") ? "&" : "?"}limit=100`;
      for (let page = 0; next && page < 20; page += 1) {
        const body = await get(next);
        if (Array.isArray(body.items)) items.push(...body.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")));
        next = typeof body.next_page === "string" && body.next_page ? body.next_page : null;
        if (next && !next.startsWith("http") && !next.startsWith("/")) next = `/${next}`;
        if (next?.startsWith("/v2/")) next = next.slice(3);
      }
      return items;
    };
    let projectId = config.projectId;
    if (!projectId) {
      const projects = await list("/projects");
      if (projects.length !== 1) {
        return report("unknown", [`RevenueCat returned ${projects.length} projects. Set REVENUECAT_PROJECT_ID to pick one. The product check stays unchecked.`]);
      }
      projectId = typeof projects[0]?.id === "string" ? projects[0].id : null;
      if (!projectId) return report("unknown", ["RevenueCat returned a project without an id. The product check stays unchecked."]);
    }
    const base = `/projects/${encodeURIComponent(projectId)}`;
    const [products, entitlements, offerings] = await Promise.all([list(`${base}/products`), list(`${base}/entitlements`), list(`${base}/offerings`)]);
    const storeIds = products.flatMap((item) => typeof item.store_identifier === "string" ? [item.store_identifier] : []);
    const known = new Set(storeIds);
    // A Play subscription product id can be written as productId:basePlanId in RevenueCat.
    for (const id of storeIds) if (id.includes(":")) known.add(id.split(":")[0] ?? id);
    const missing = codeProductIds.filter((id) => !known.has(id));
    const lines = [
      `RevenueCat project ${projectId}: ${products.length} products, ${entitlements.length} entitlements, ${offerings.length} offerings (read only).`,
    ];
    let status: RevenueCatStatus;
    if (codeProductIds.length > 0) {
      status = missing.length === 0 ? "match" : "mismatch";
      lines.push(missing.length === 0
        ? `All ${codeProductIds.length} product IDs written in the code are configured in RevenueCat.`
        : `Product IDs in the code that RevenueCat does not list: ${missing.join(", ")}.`);
    } else {
      status = products.length > 0 && entitlements.length > 0 && offerings.length > 0 ? "configured" : "incomplete";
      lines.push(status === "configured"
        ? "No product IDs are written in the code (offerings are fetched at run time). RevenueCat has at least one product, entitlement, and offering."
        : "No product IDs are written in the code, and RevenueCat is missing products, entitlements, or offerings.");
    }
    return {
      status,
      facts: { "connect.revenuecat": status },
      evidence: [{ facts: ["connect.revenuecat"], kind: "live", detail: lines.join(" "), snippet: `products=${products.length} entitlements=${entitlements.length} offerings=${offerings.length}` }],
      lines,
      products: storeIds,
      entitlements: entitlements.length,
      offerings: offerings.length,
      missingInRevenueCat: missing,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    return report("unknown", [`RevenueCat was not read. ${message.replace(/Bearer\s+\S+/g, "Bearer [redacted]").replace(/sk_[A-Za-z0-9]+/g, "sk_[redacted]")} The product check stays unchecked.`]);
  }
}
