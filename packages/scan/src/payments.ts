/**
 * Paywall and RevenueCat signals read from source text. Every signal is a
 * phrase or API name match. Nothing here runs the app or calls a store.
 */

export interface SourceText {
  path: string;
  text: string;
}

export interface PaymentHit {
  path: string;
  line: number;
  snippet: string;
}

export interface PaymentSignals {
  restore: PaymentHit | null;
  termsLink: PaymentHit | null;
  renewal: PaymentHit | null;
  period: PaymentHit | null;
  secretKey: PaymentHit | null;
  revenueCatConfigured: PaymentHit | null;
  productIds: string[];
}

/** RevenueCat restore calls on each SDK plus StoreKit, Play Billing, and visible button text. */
const RESTORE = /restorePurchases|restore_purchases|RestorePurchases|restoreCompletedTransactions|AppStore\.sync\s*\(|restoreTransactions|restore purchases|restore purchase|satın alımları geri yükle|satin alimlari geri yukle|geri yükle/i;
const TERMS = /terms of use|terms of service|terms & conditions|terms and conditions|\beula\b|stdeula|kullanım koşulları|kullanim kosullari|hizmet şartları/i;
const RENEWAL = /auto-renew|autorenew|auto renew|renews automatically|automatically renew|renew automatically|otomatik olarak yenilen|otomatik yenilen/i;
const PERIOD = /per month|per year|per week|\/month|\/year|\/week|monthly|yearly|annually|weekly|aylık|yıllık|haftalık|P1M|P1Y|P1W/i;
/** RevenueCat says secret keys are prefixed sk_. Stripe keys (sk_live_, sk_test_) are a different vendor and are skipped here. */
const SECRET = /["'`](sk_(?!live_|test_)[A-Za-z0-9]{16,})["'`]/;
const CONFIGURE = /Purchases\s*\.\s*(?:configure|setup|configureWith|shared)|PurchasesConfiguration|Purchases\.sharedInstance|RevenueCat\.Purchases|Purchases\.Configure/;
const PRODUCT_CALLS = [
  /(?:getProducts|fetchProducts|products|getStoreProducts)\s*\(\s*\[\s*([^\]]{1,400})\]/g,
  /productIdentifiers?\s*[:=]\s*\[\s*([^\]]{1,400})\]/g,
];

export function paymentSignals(files: readonly SourceText[]): PaymentSignals {
  const out: PaymentSignals = { restore: null, termsLink: null, renewal: null, period: null, secretKey: null, revenueCatConfigured: null, productIds: [] };
  const ids = new Set<string>();
  for (const file of files) {
    out.restore ??= hit(file, RESTORE);
    out.termsLink ??= hit(file, TERMS);
    out.renewal ??= hit(file, RENEWAL);
    out.period ??= hit(file, PERIOD);
    out.revenueCatConfigured ??= hit(file, CONFIGURE);
    if (!out.secretKey) {
      const match = SECRET.exec(file.text);
      if (match) out.secretKey = { path: file.path, line: lineAt(file.text, match.index), snippet: "sk_… (secret key, redacted)" };
    }
    for (const pattern of PRODUCT_CALLS) {
      for (const match of file.text.matchAll(pattern)) {
        for (const literal of (match[1] ?? "").matchAll(/["']([A-Za-z0-9._:-]{2,120})["']/g)) {
          if (literal[1]) ids.add(literal[1]);
        }
      }
    }
  }
  out.productIds = [...ids].sort();
  return out;
}

function hit(file: SourceText, pattern: RegExp): PaymentHit | null {
  const match = pattern.exec(file.text);
  if (!match) return null;
  return { path: file.path, line: lineAt(file.text, match.index), snippet: lineText(file.text, match.index) };
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 200);
}
