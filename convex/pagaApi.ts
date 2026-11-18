"use node";

// Paga Business API client — getBanks, validateDepositToBank, depositToBank,
// transactionStatus. Paga only accepts API calls from IP addresses whitelisted
// in the business portal, and Convex has no static egress IP, so calls can be
// routed through a machine whose IP is whitelisted:
//
//   PAGA_RELAY_URL + PAGA_RELAY_SECRET — dev relay: the Vite dev server
//     forwards /paga-relay/* to Paga from the developer's machine (see
//     frontend/vite.config.ts). e.g. https://<ngrok-domain>/paga-relay
//   PAGA_PROXY_URL — or a fixed-IP HTTP proxy (http://user:pass@host:port).
//
// With neither set, calls go direct (works once Convex's IP is accepted).

import { v } from "convex/values";
import { ProxyAgent } from "undici";
import { internalAction } from "./_generated/server";
import {
  PAGA_BUSINESS_BASE,
  PAGA_BUSINESS_PATH,
  PAGA_TRANSFER_CALLBACK_PATH,
  pagaCallbackUrl,
  pagaHash,
  pagaReference,
  requirePagaEnv,
} from "./paga";

let proxyAgent: ProxyAgent | undefined;
function dispatcher(): ProxyAgent | undefined {
  const url = process.env.PAGA_PROXY_URL;
  if (!url) return undefined;
  proxyAgent ??= new ProxyAgent(url);
  return proxyAgent;
}

/**
 * POSTs to a Business API operation. Returns the parsed body, or null when the
 * outcome is unknown (network error, timeout, non-JSON or 5xx) — callers must
 * treat null as "may or may not have happened", never as a failure.
 */
async function businessCall(
  operation: string,
  body: Record<string, unknown>,
  hashValues: (string | number | undefined)[]
): Promise<Record<string, unknown> | null> {
  const { publicKey, secretKey, hashKey } = requirePagaEnv();
  const hash = await pagaHash(hashValues, hashKey);

  const relayUrl = process.env.PAGA_RELAY_URL?.replace(/\/$/, "");
  const url = relayUrl
    ? `${relayUrl}${PAGA_BUSINESS_PATH}/${operation}`
    : `${PAGA_BUSINESS_BASE}/${operation}`;
  const relayHeaders: Record<string, string> = relayUrl
    ? {
        "x-chop-relay-secret": process.env.PAGA_RELAY_SECRET ?? "",
        // ngrok free tunnels show an interstitial page unless this is set
        "ngrok-skip-browser-warning": "1",
      }
    : {};

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        principal: publicKey,
        credentials: secretKey,
        hash,
        ...relayHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      // `dispatcher` is undici's extension to fetch — not in the DOM RequestInit type
      ...({ dispatcher: dispatcher() } as object),
    });
    const text = await res.text();
    if (res.status >= 500) {
      console.error(`Paga ${operation}: HTTP ${res.status}`, text.slice(0, 500));
      return null;
    }
    if (res.status >= 400) {
      console.error(`Paga ${operation}: HTTP ${res.status}`, text.slice(0, 500));
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.error(`Paga ${operation}: non-JSON response (HTTP ${res.status})`, text.slice(0, 500));
      return res.status >= 400 ? { responseCode: -1, message: `HTTP ${res.status}` } : null;
    }
  } catch (err) {
    console.error(`Paga ${operation}: request failed`, err);
    return null;
  }
}

const responseCode = (body: Record<string, unknown>) =>
  body.responseCode as number | string | null | undefined;

// ── Operations ────────────────────────────────────────────────────────────────

/** Every institution Paga can pay into. `uuid` is what depositToBank needs. */
export const getBanks = internalAction({
  args: {},
  handler: async (): Promise<{ name: string; uuid: string }[]> => {
    const referenceNumber = pagaReference("BNK");
    const body = await businessCall("getBanks", { referenceNumber }, [referenceNumber]);
    if (!body || Number(responseCode(body)) !== 0) {
      if (body) console.error("Paga getBanks rejected", { responseCode: responseCode(body), message: body.message });
      throw new Error("Could not load banks. Please try again.");
    }
    const banks = (body.banks ?? []) as { name: string; uuid: string }[];
    return banks.map((b) => ({ name: b.name, uuid: b.uuid }));
  },
});

/**
 * Confirms the account exists and returns the holder's name at the bank.
 * Validation doesn't move money and needs an amount for the fee quote — any
 * positive amount works for a name lookup.
 */
export const validateDepositToBank = internalAction({
  args: {
    bankUUID: v.string(),
    accountNumber: v.string(),
    amountKobo: v.optional(v.number()),
  },
  handler: async (_ctx, { bankUUID, accountNumber, amountKobo }) => {
    const referenceNumber = pagaReference("VAL");
    const amount = ((amountKobo ?? 10_000) / 100).toFixed(2);
    const body = await businessCall(
      "validateDepositToBank",
      {
        referenceNumber,
        amount,
        currency: "NGN",
        destinationBankUUID: bankUUID,
        destinationBankAccountNumber: accountNumber,
      },
      [referenceNumber, amount, bankUUID, accountNumber]
    );
    // No responseCode means Paga rejected the call itself (e.g. HTTP 401, IP not whitelisted)
    if (!body || body.responseCode === undefined) {
      return { ok: false as const, message: "Could not verify account. Please try again." };
    }
    const name = body.destinationAccountHolderNameAtBank as string | undefined;
    if (Number(responseCode(body)) !== 0 || !name) {
      console.warn("Paga validateDepositToBank rejected", { responseCode: responseCode(body), message: body.message });
      return { ok: false as const, message: "Account not found. Check the number and bank." };
    }
    return { ok: true as const, accountName: name, feeNaira: Number(body.fee ?? 0) };
  },
});

/**
 * Sends money from the Paga business balance. Re-sending with the SAME
 * reference is safe: Paga answers 105 (duplicate) instead of paying twice.
 */
export const depositToBank = internalAction({
  args: {
    reference: v.string(),
    amount: v.string(),
    bankUUID: v.string(),
    accountNumber: v.string(),
    recipientName: v.string(),
    remarks: v.string(),
  },
  handler: async (_ctx, args) => {
    const body = await businessCall(
      "depositToBank",
      {
        referenceNumber: args.reference,
        amount: args.amount,
        currency: "NGN",
        destinationBankUUID: args.bankUUID,
        destinationBankAccountNumber: args.accountNumber,
        recipientName: args.recipientName,
        remarks: args.remarks,
        alternateSenderName: "Chop",
        statusCallbackUrl: pagaCallbackUrl(PAGA_TRANSFER_CALLBACK_PATH),
      },
      [args.reference, args.amount, args.bankUUID, args.accountNumber]
    );
    if (!body) return { responseCode: null, message: null, transactionId: null };
    return {
      responseCode: responseCode(body) ?? null,
      message: (body.message as string | null) ?? null,
      transactionId: (body.transactionId as string | null) ?? null,
    };
  },
});

/** Status of a transaction from the last 48 hours, by our reference. */
export const transactionStatus = internalAction({
  args: { reference: v.string() },
  handler: async (_ctx, { reference }) => {
    const body = await businessCall(
      "transactionStatus",
      { referenceNumber: reference, locale: "en" },
      [reference]
    );
    if (!body) return { responseCode: null, message: null, transactionId: null };
    return {
      responseCode: responseCode(body) ?? null,
      message: (body.message as string | null) ?? null,
      transactionId: (body.transactionId as string | null) ?? null,
    };
  },
});

/**
 * Reports the public IP this deployment's Node actions call out from — the
 * address Paga sees, which must be on the Paga IP whitelist when no relay or
 * proxy is used. Run: npx convex run pagaApi:egressIp
 */
export const egressIp = internalAction({
  args: {},
  handler: async (): Promise<string> => {
    const res = await fetch("https://api.ipify.org");
    return (await res.text()).trim();
  },
});
