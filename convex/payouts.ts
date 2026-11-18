import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { TRANSFER_FEE_KOBO, CHOPIN_FEE_THRESHOLD_KOBO } from "./fees";
import { classifyPagaResponseCode, koboToNaira, pagaReference } from "./paga";

/**
 * Delays between transactionStatus checks while a payout's outcome is unknown.
 * Paga needs ≥5s before the first check, and status only covers 48 hours.
 */
const STATUS_CHECK_DELAYS_MS = [
  15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000,
];
/** Safety-net check after Paga accepts a transfer, in case its callback never lands. */
const ACCEPTED_CHECK_DELAY_MS = 2 * 60_000;

// ── Public queries ─────────────────────────────────────────────────────────────

/**
 * Returns all payouts for the current user, newest first.
 */
export const listPayouts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return ctx.db
      .query("payouts")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .order("desc")
      .collect();
  },
});

/**
 * Returns all completed (status="closed") chop-in sessions for the current user.
 * These are eligible for withdrawal via the wallet page.
 */
export const listCompletedChopIn = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .order("desc")
      .collect();

    const chopInClosed = sessions.filter(
      (s) => s.mode === "chop-in" && s.status === "closed"
    );

    const withAmounts = await Promise.all(
      chopInClosed.map(async (session) => {
        const participants = await ctx.db
          .query("participants")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect();
        const collectedKobo = participants
          .filter((p) => p.status === "sent")
          .reduce((s, p) => s + p.amountOwed, 0);
        const feeKobo = collectedKobo < CHOPIN_FEE_THRESHOLD_KOBO
          ? TRANSFER_FEE_KOBO
          : 0;
        return {
          ...session,
          collectedKobo,
          transferFeeKobo: feeKobo,
          feeKobo,
          payoutKobo: collectedKobo - feeKobo,
        };
      })
    );

    // Only return sessions that have actual funds to withdraw.
    return withAmounts.filter((s) => s.collectedKobo > 0);
  },
});

// ── Public actions ─────────────────────────────────────────────────────────────

/**
 * Fetches the list of Nigerian banks from Paga.
 * Requires auth — prevents unauthenticated quota burn on the Paga API.
 * Returns [{ name, code }] sorted by name, where `code` is Paga's bank UUID.
 */
export const listBanks = action({
  args: {},
  handler: async (ctx): Promise<{ name: string; code: string }[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const banks = await ctx.runAction(internal.pagaApi.getBanks, {});
    return banks
      .map((b) => ({ name: b.name, code: b.uuid }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Resolves a Nigerian bank account number to the account holder's name.
 * Requires auth — prevents unauthenticated enumeration of bank accounts.
 */
export const resolveAccount = action({
  args: {
    accountNumber: v.string(),
    bankCode: v.string(),
  },
  handler: async (ctx, { accountNumber, bankCode }): Promise<{ accountName: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const result = await ctx.runAction(internal.pagaApi.validateDepositToBank, {
      bankUUID: bankCode,
      accountNumber,
    });
    if (!result.ok) throw new Error(result.message);
    return { accountName: result.accountName };
  },
});

/**
 * Pays a completed session's pot out to the organizer's bank account via Paga.
 * The recipient name is resolved by Paga — never supplied by the user.
 *
 * Flow:
 *   1. validateDepositToBank         → recipient name at the bank
 *   2. claimPayout (one mutation)    → guards + inserts the "pending" row with its
 *                                      reference BEFORE any money moves, so a
 *                                      double-click or retry can't pay twice
 *   3. depositToBank (same reference)→ "processing" on accept, "failed" on a
 *                                      definite rejection, stays "pending" with
 *                                      status checks scheduled when unknown
 *   4. Transfer callback / status check flips it to "completed" and the
 *      session to "inactive"
 */
export const requestPayout = action({
  args: {
    sessionId: v.id("sessions"),
    accountNumber: v.string(),
    bankCode: v.string(),
    bankName: v.string(),
  },
  handler: async (ctx, args): Promise<{ reference: string; resolvedName: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // ── 1. Validate the destination ─────────────────────────────────────────
    const validation = await ctx.runAction(internal.pagaApi.validateDepositToBank, {
      bankUUID: args.bankCode,
      accountNumber: args.accountNumber,
    });
    if (!validation.ok) throw new Error(validation.message);

    // ── 2. Claim (atomic guard + insert) ─────────────────────────────────────
    const { payoutId, reference } = await ctx.runMutation(internal.payouts.claimPayout, {
      sessionId: args.sessionId,
      organizerId: userId,
      recipientName: validation.accountName,
      accountNumber: args.accountNumber,
      bankName: args.bankName,
      bankCode: args.bankCode,
    });

    // ── 3. Send ──────────────────────────────────────────────────────────────
    const outcome = await submitDeposit(ctx, payoutId);
    if (outcome.status === "failed") throw new Error(outcome.message);

    return { reference, resolvedName: validation.accountName };
  },
});

// ── Payout state machine ───────────────────────────────────────────────────────

/**
 * Sends depositToBank for a claimed payout and records the outcome. Safe to
 * call again for the same payout: the reference never changes, and Paga
 * answers 105 (duplicate) rather than paying twice.
 */
async function submitDeposit(
  ctx: ActionCtx,
  payoutId: Id<"payouts">,
  /** Status-check attempt to schedule if the outcome is unknown */
  nextAttempt = 0
): Promise<{ status: "processing" | "pending" | "failed"; message: string }> {
  const payout = await ctx.runQuery(internal.payouts._getPayout, { payoutId });
  if (!payout || !payout.bankCode) throw new Error("Payout not found");

  const result = await ctx.runAction(internal.pagaApi.depositToBank, {
    reference: payout.reference,
    amount: koboToNaira(payout.amountKobo),
    bankUUID: payout.bankCode,
    accountNumber: payout.accountNumber,
    recipientName: payout.recipientName,
    remarks: `Chop payout ${payout.reference}`,
  });

  const outcome = classifyPagaResponseCode(result.responseCode);

  if (outcome === "failed") {
    const message = result.message ?? `Payout failed (code ${result.responseCode})`;
    await ctx.runMutation(internal.payouts.failPayout, { payoutId, reason: message });
    return { status: "failed", message };
  }

  if (outcome === "success" || outcome === "pending") {
    await ctx.runMutation(internal.payouts.markPayoutProcessing, {
      payoutId,
      pagaTransactionId: result.transactionId ?? undefined,
    });
    await ctx.scheduler.runAfter(ACCEPTED_CHECK_DELAY_MS, internal.payouts.checkPayoutStatus, {
      payoutId,
      attempt: 0,
    });
    return { status: "processing", message: "Payout accepted" };
  }

  // Unknown outcome (timeout, -1, 105, 135, unlisted code) — the money may have
  // moved. Never resend with a new reference; check status instead.
  console.warn(`Paga depositToBank ${payout.reference}: unknown outcome (code ${result.responseCode}) — checking status`);
  await ctx.scheduler.runAfter(STATUS_CHECK_DELAYS_MS[nextAttempt], internal.payouts.checkPayoutStatus, {
    payoutId,
    attempt: nextAttempt,
  });
  return { status: "pending", message: "Payout submitted, confirming with the bank" };
}

/**
 * Reconciles a payout whose final outcome we haven't heard yet, by its
 * reference. Reschedules itself with backoff until the outcome is known.
 */
export const checkPayoutStatus = internalAction({
  args: { payoutId: v.id("payouts"), attempt: v.number() },
  handler: async (ctx, { payoutId, attempt }) => {
    const payout = await ctx.runQuery(internal.payouts._getPayout, { payoutId });
    if (!payout || payout.status === "completed" || payout.status === "failed") return;

    const result = await ctx.runAction(internal.pagaApi.transactionStatus, {
      reference: payout.reference,
    });
    const code = result.responseCode === null ? null : Number(result.responseCode);
    const outcome = classifyPagaResponseCode(code);

    if (outcome === "success") {
      await ctx.runMutation(internal.payouts.completePayout, {
        payoutId,
        pagaTransactionId: result.transactionId ?? undefined,
      });
      return;
    }
    if (outcome === "failed") {
      await ctx.runMutation(internal.payouts.failPayout, {
        payoutId,
        reason: result.message ?? `Payout failed (code ${code})`,
      });
      return;
    }

    const next = attempt + 1;

    // 135 = Paga has no record of this reference: the deposit never landed.
    // Resubmitting with the exact same reference is the documented recovery;
    // submitDeposit schedules its own follow-up check.
    if (code === 135 && payout.status === "pending" && next < STATUS_CHECK_DELAYS_MS.length) {
      await submitDeposit(ctx, payoutId, next);
      return;
    }

    if (next >= STATUS_CHECK_DELAYS_MS.length) {
      console.error(
        `Payout ${payout.reference}: outcome still unknown after ${next} status checks — reconcile manually in the Paga dashboard`
      );
      return;
    }
    await ctx.scheduler.runAfter(STATUS_CHECK_DELAYS_MS[next], internal.payouts.checkPayoutStatus, {
      payoutId,
      attempt: next,
    });
  },
});

/**
 * Validates the session and inserts the payout row in one transaction.
 * Convex mutations are serializable, so two concurrent requests for the same
 * session can't both pass the "no active payout" guard.
 */
export const claimPayout = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    organizerId: v.string(),
    recipientName: v.string(),
    accountNumber: v.string(),
    bankName: v.string(),
    bankCode: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.organizerId !== args.organizerId) throw new Error("Not your session");
    if (session.status !== "closed") throw new Error("Session must be completed before payout");

    // ── Duplicate payout guard ────────────────────────────────────────────────
    const existing = await ctx.db
      .query("payouts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const active = existing.filter(
      (p) => p.status === "pending" || p.status === "processing" || p.status === "completed" || p.status === "processed"
    );
    if (active.length > 0) {
      throw new Error(
        "A payout for this session is already in progress or completed. Check your wallet."
      );
    }

    // ── Compute payout amount ────────────────────────────────────────────────
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const collectedKobo = participants
      .filter((p) => p.status === "sent")
      .reduce((s, p) => s + p.amountOwed, 0);
    // ₦50 transfer fee only when collected < ₦5,000; platform absorbs it above that threshold
    const transferFeeKobo = collectedKobo < CHOPIN_FEE_THRESHOLD_KOBO
      ? TRANSFER_FEE_KOBO
      : 0;
    const amountKobo = collectedKobo - transferFeeKobo;
    if (amountKobo <= 0) throw new Error("Nothing to pay out for this session");

    const reference = pagaReference("CPO");
    const payoutId = await ctx.db.insert("payouts", {
      ...args,
      amountKobo,
      reference,
      status: "pending",
    });
    return { payoutId, reference };
  },
});

export const markPayoutProcessing = internalMutation({
  args: { payoutId: v.id("payouts"), pagaTransactionId: v.optional(v.string()) },
  handler: async (ctx, { payoutId, pagaTransactionId }) => {
    const payout = await ctx.db.get(payoutId);
    if (!payout || payout.status !== "pending") return;
    await ctx.db.patch(payoutId, {
      status: "processing",
      ...(pagaTransactionId ? { pagaTransactionId } : {}),
    });
  },
});

/**
 * Money delivered: payout → completed, session → inactive, organizer notified
 * in-app and by email. Idempotent — repeat callbacks and status checks no-op.
 */
export const completePayout = internalMutation({
  args: { payoutId: v.id("payouts"), pagaTransactionId: v.optional(v.string()) },
  handler: async (ctx, { payoutId, pagaTransactionId }) => {
    const payout = await ctx.db.get(payoutId);
    if (!payout || payout.status === "completed") return;

    await ctx.db.patch(payoutId, {
      status: "completed",
      failureReason: undefined,
      ...(pagaTransactionId ? { pagaTransactionId } : {}),
    });
    await ctx.db.patch(payout.sessionId, { status: "inactive" });

    const naira = Math.round(payout.amountKobo / 100).toLocaleString("en-NG");
    const masked = "•".repeat(payout.accountNumber.length - 4) + payout.accountNumber.slice(-4);
    await ctx.db.insert("notifications", {
      userId: payout.organizerId,
      type: "session_closed",
      title: `₦${naira} delivered to your bank`,
      body: `Your payout to ${payout.bankName} (${masked}) has landed.`,
      sessionId: payout.sessionId,
      read: false,
    });

    const organizer = await ctx.db.get(payout.organizerId as Id<"users">);
    if (organizer?.email) {
      const session = await ctx.db.get(payout.sessionId);
      await ctx.scheduler.runAfter(0, internal.notifications.sendOrganizerPayout, {
        organizerEmail: organizer.email,
        organizerName: organizer.name ?? organizer.email.split("@")[0],
        sessionName: session?.name ?? "Your session",
        amountKobo: payout.amountKobo,
        bankName: payout.bankName,
        accountNumber: payout.accountNumber,
        reference: payout.reference,
      });
    }
  },
});

/**
 * Paga rejected the transfer: payout → failed so the organizer can retry from
 * the dashboard (the duplicate guard ignores failed rows). Never downgrades a
 * completed payout.
 */
export const failPayout = internalMutation({
  args: { payoutId: v.id("payouts"), reason: v.string() },
  handler: async (ctx, { payoutId, reason }) => {
    const payout = await ctx.db.get(payoutId);
    if (!payout || payout.status === "completed" || payout.status === "failed") return;

    await ctx.db.patch(payoutId, { status: "failed", failureReason: reason });
    await ctx.db.insert("notifications", {
      userId: payout.organizerId,
      type: "session_closed",
      title: "Payout failed",
      body: `Your payout to ${payout.bankName} could not be delivered: ${reason}. Please try again from your dashboard.`,
      sessionId: payout.sessionId,
      read: false,
    });
  },
});

// ── Internal helpers ──────────────────────────────────────────────────────────

export const _getPayout = internalQuery({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => ctx.db.get(payoutId),
});

export const findPayoutByReference = internalQuery({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) =>
    ctx.db
      .query("payouts")
      .withIndex("by_reference", (q) => q.eq("reference", reference))
      .unique(),
});
