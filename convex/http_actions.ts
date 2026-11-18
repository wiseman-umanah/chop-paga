import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { classifyPagaResponseCode, hashesEqual, nairaToKobo, pagaHash } from "./paga";

/**
 * Paga signs callbacks with SHA-512 over field values "exactly as received".
 * JSON.parse would turn a numeric 5000.0 into 5000, so hash inputs are read
 * from the raw body text; parsed values are only a fallback.
 */
function rawField(rawBody: string, name: string, parsed: Record<string, unknown>): string {
  const match = new RegExp(`"${name}"\\s*:\\s*("((?:[^"\\\\]|\\\\.)*)"|[^,}\\s]+)`).exec(rawBody);
  if (match) {
    if (match[2] !== undefined) return match[2];
    return match[1] === "null" ? "" : match[1];
  }
  const value = parsed[name];
  return value === null || value === undefined ? "" : String(value);
}

function parseBody(rawBody: string): Record<string, unknown> | null {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Fall back to form encoding, which some Paga callbacks use
    const form = new URLSearchParams(rawBody);
    return [...form.keys()].length > 0 ? Object.fromEntries(form) : null;
  }
}

/**
 * Paga Checkout payment notification — POST /paga/checkout-callback.
 *
 * Payload: { statusCode, statusMessage, paymentReference, amount, currency,
 *            timeStamp, customerEmail, customerPhoneNumber, hash }
 * Hash:    sha512(amount + timeStamp + paymentReference + hashKey)
 *
 * paymentReference is the CHP-… reference we generated in initiateCheckout;
 * the checkouts table maps it to the participant and the expected amount.
 */
export const pagaCheckoutCallback = httpAction(async (ctx, request) => {
  const hashKey = process.env.PAGA_HASH_KEY;
  if (!hashKey) {
    console.error("PAGA_HASH_KEY env variable not set");
    return new Response("Server misconfiguration", { status: 500 });
  }

  const rawBody = await request.text();
  const body = parseBody(rawBody);
  if (!body) return new Response("Invalid body", { status: 400 });

  const amount = rawField(rawBody, "amount", body);
  const timeStamp = rawField(rawBody, "timeStamp", body);
  const paymentReference = rawField(rawBody, "paymentReference", body);
  const receivedHash = String(body.hash ?? "");

  const expected = await pagaHash([amount, timeStamp, paymentReference], hashKey);
  if (!receivedHash || !hashesEqual(expected, receivedHash)) {
    console.warn("Paga checkout callback: hash mismatch", { paymentReference });
    return new Response("Invalid hash", { status: 401 });
  }

  if (String(body.statusCode) !== "0") {
    console.log(`Paga checkout ${paymentReference}: not successful (${body.statusCode} ${body.statusMessage ?? ""})`);
    return new Response("OK", { status: 200 });
  }

  const amountKobo = nairaToKobo(amount);
  if (amountKobo === undefined) {
    console.error(`Paga checkout ${paymentReference}: unparseable amount "${amount}"`);
    return new Response("OK", { status: 200 });
  }

  try {
    const outcome = await ctx.runMutation(internal.payments.confirmCheckoutPayment, {
      reference: paymentReference,
      amountKobo,
    });
    console.log(`Paga checkout ${paymentReference}: ${outcome}`);
  } catch (err) {
    console.error("Paga checkout callback: failed to apply payment", err);
    return new Response("Internal error", { status: 500 }); // Paga retries
  }

  return new Response("OK", { status: 200 });
});

/** Default order when Paga omits x-paga-hash-parameters. */
const TRANSFER_HASH_PARAMS = ["referenceNumber", "transactionDate", "transactionId", "amount", "sessionId", "hashKey"];

/**
 * Paga money-transfer notification — POST /paga/transfer-callback.
 * Sent to depositToBank's statusCallbackUrl once a payout is processed.
 *
 * Hash is in the x-paga-hash header, over the body fields named (in order) by
 * x-paga-hash-parameters, with "hashKey" standing for our key. Paga retries
 * until it gets HTTP 200 with {"status": "SUCCESS"}.
 */
export const pagaTransferCallback = httpAction(async (ctx, request) => {
  const hashKey = process.env.PAGA_HASH_KEY;
  if (!hashKey) {
    console.error("PAGA_HASH_KEY env variable not set");
    return new Response("Server misconfiguration", { status: 500 });
  }

  const rawBody = await request.text();
  const body = parseBody(rawBody);
  if (!body) return new Response("Invalid body", { status: 400 });

  const receivedHash = request.headers.get("x-paga-hash");
  const params = (request.headers.get("x-paga-hash-parameters") ?? TRANSFER_HASH_PARAMS.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!receivedHash || !params.includes("referenceNumber") || params[params.length - 1] !== "hashKey") {
    return new Response("Invalid hash", { status: 401 });
  }

  const values = params.slice(0, -1).map((p) => rawField(rawBody, p, body));
  const expected = await pagaHash(values, hashKey);
  if (!hashesEqual(expected, receivedHash)) {
    console.warn("Paga transfer callback: hash mismatch", { referenceNumber: body.referenceNumber });
    return new Response("Invalid hash", { status: 401 });
  }

  const ack = () =>
    new Response(JSON.stringify({ status: "SUCCESS" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const reference = String(body.referenceNumber ?? "");
  try {
    const payout = await ctx.runQuery(internal.payouts.findPayoutByReference, { reference });
    if (!payout) {
      console.warn("Paga transfer callback: no payout for reference", reference);
      return ack();
    }

    const transactionId = body.transactionId ? String(body.transactionId) : undefined;
    switch (classifyPagaResponseCode(body.responseCode as number | string | undefined)) {
      case "success":
        await ctx.runMutation(internal.payouts.completePayout, {
          payoutId: payout._id,
          pagaTransactionId: transactionId,
        });
        break;
      case "failed":
        await ctx.runMutation(internal.payouts.failPayout, {
          payoutId: payout._id,
          reason: String(body.message ?? `code ${body.responseCode}`),
        });
        break;
      case "pending":
        break; // a final notification follows
      case "unknown":
        // Don't guess — confirm with transactionStatus (Paga needs ≥5s to sync)
        await ctx.scheduler.runAfter(15_000, internal.payouts.checkPayoutStatus, {
          payoutId: payout._id,
          attempt: 0,
        });
        break;
    }
  } catch (err) {
    console.error("Paga transfer callback: handler error", err);
    return new Response("Internal error", { status: 500 });
  }

  return ack();
});
