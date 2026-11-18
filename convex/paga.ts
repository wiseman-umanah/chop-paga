// Shared Paga helpers — plain functions with no Node dependencies, safe to call
// from queries, mutations, actions and HTTP actions.
//
// Paga has three surfaces we use:
//   Checkout     — hosted payment page (card, transfer, USSD, Paga wallet). We
//                  redirect the payer to a payment link; no server call needed.
//   Business API — getBanks, validateDepositToBank, depositToBank, transactionStatus.
//                  Called from convex/pagaApi.ts (Node runtime, optional fixed-IP proxy).
//   Callbacks    — Checkout payment notification + money-transfer notification,
//                  both SHA-512 signed with PAGA_HASH_KEY (see http_actions.ts).

const isLive = process.env.PAGA_ENV === "live";

export const PAGA_CHECKOUT_BASE = isLive
  ? "https://checkout.paga.com"
  : "https://beta-checkout.paga.com";

export const PAGA_BUSINESS_PATH = "/paga-webservices/business-rest/secured";

export const PAGA_BUSINESS_BASE = isLive
  ? `https://www.mypaga.com${PAGA_BUSINESS_PATH}`
  : `https://beta.mypaga.com${PAGA_BUSINESS_PATH}`;

/** Funding sources offered on the hosted Checkout page, in display order. */
export const PAGA_FUNDING_SOURCES = "CARD,TRANSFER,USSD,PAGA";

/** HTTP routes Paga calls back on (mounted in http.ts). */
export const PAGA_CHECKOUT_CALLBACK_PATH = "/paga/checkout-callback";
export const PAGA_TRANSFER_CALLBACK_PATH = "/paga/transfer-callback";

export function requirePagaEnv(): { publicKey: string; secretKey: string; hashKey: string } {
  const publicKey = process.env.PAGA_PUBLIC_KEY;
  const secretKey = process.env.PAGA_SECRET_KEY;
  const hashKey = process.env.PAGA_HASH_KEY;
  if (!publicKey || !secretKey || !hashKey) {
    throw new Error("Paga is not configured (PAGA_PUBLIC_KEY / PAGA_SECRET_KEY / PAGA_HASH_KEY)");
  }
  return { publicKey, secretKey, hashKey };
}

/** Public URL Paga should call back on — Convex sets CONVEX_SITE_URL for every deployment. */
export function pagaCallbackUrl(path: string): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is not set");
  return `${site.replace(/\/$/, "")}${path}`;
}

/** kobo → Paga decimal naira string, e.g. 75000 → "750.00" */
export function koboToNaira(kobo: number): string {
  return (kobo / 100).toFixed(2);
}

/** Paga decimal naira (string or number) → kobo, or undefined if unparseable. */
export function nairaToKobo(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

/**
 * Unique reference, e.g. "CHP-9F2A61C0B7D4". Paga caps references at 50 chars.
 * crypto.randomUUID() is available in both the V8 and Node runtimes.
 */
export function pagaReference(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

/** SHA-512 hex of the concatenated values + hashKey — Paga's request/callback hash. */
export async function pagaHash(values: (string | number | null | undefined)[], hashKey: string): Promise<string> {
  const text = values.map((v) => (v === null || v === undefined ? "" : String(v))).join("") + hashKey;
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison of two hex strings (case-insensitive). */
export function hashesEqual(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ── Business API response codes ───────────────────────────────────────────────
// https://developer-docs.paga.com/docs/error-codes
//
// Only 0 is success and only 3 is "pending". -1, 105 and 135 (and anything
// unlisted, and any timeout) are UNKNOWN outcomes: the transfer may have gone
// through, so we must check status with the SAME reference — never resend with
// a new one. Everything else listed is a definite failure.

export type PagaOutcome = "success" | "pending" | "unknown" | "failed";

const FAILED_CODES = new Set([
  -9, -8, -4, -3, -2, 2, 4, 101, 103, 104, 106, 107, 108, 109, 110, 111, 112, 113,
  114, 115, 116, 117, 118, 119, 122, 123, 124, 125, 126, 127, 129, 130, 131, 132,
  133, 134, 136, 137, 138, 139, 140,
]);

export function classifyPagaResponseCode(code: number | string | null | undefined): PagaOutcome {
  const n = typeof code === "string" ? parseInt(code, 10) : code;
  if (n === 0) return "success";
  if (n === 3) return "pending";
  if (n !== null && n !== undefined && FAILED_CODES.has(n)) return "failed";
  return "unknown";
}
