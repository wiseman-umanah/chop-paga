import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { markParticipantPaid } from "./participants";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { calculateSettlementFeeNaira, computeParticipantFees, computeChopInCharge, CHOPIN_MIN_CONTRIBUTION_KOBO } from "./fees";
import {
  PAGA_CHECKOUT_BASE,
  PAGA_CHECKOUT_CALLBACK_PATH,
  PAGA_FUNDING_SOURCES,
  koboToNaira,
  pagaCallbackUrl,
  pagaReference,
} from "./paga";

// ── Pre-insert participant for chop-in ────────────────────────────────────────

/**
 * Inserts a pending participant row for a chop-in contributor BEFORE redirecting
 * to Paga Checkout. This gives us a stable participantId to embed in metadata.
 * If the user abandons payment, the row stays pending and is harmless.
 *
 * This is an internalMutation — only callable from actions in this codebase,
 * not from any frontend client.
 */
export const reserveChopInParticipant = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    contributorName: v.string(),
    amountKobo: v.number(),
    payerEmail: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, contributorName, amountKobo, payerEmail }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.mode !== "chop-in") throw new Error("Only for chop-in sessions");

    const participantId = await ctx.db.insert("participants", {
      sessionId,
      name: contributorName || "Anonymous",
      amountOwed: amountKobo,
      status: "pending",
      contributionAmount: amountKobo,
      payerEmail: payerEmail || undefined,
    });

    return participantId;
  },
});

/**
 * Internal helper — patches payerEmail onto a food/bill participant row
 * from inside the initiateCheckout action.
 */
export const internalPatchPayerEmail = internalMutation({
  args: {
    participantId: v.id("participants"),
    payerEmail: v.string(),
  },
  handler: async (ctx, { participantId, payerEmail }) => {
    const participant = await ctx.db.get(participantId);
    if (!participant) throw new Error("Participant not found");
    await ctx.db.patch(participantId, { payerEmail });
  },
});

/**
 * Internal helper — stores the settlement fee share on a participant row after
 * checkout is initiated. Kept separate so initiateCheckout (action) can
 * write back to the DB without embedding a full mutation inline.
 */
export const internalPatchPlatformFee = internalMutation({
  args: {
    participantId: v.id("participants"),
    platformFeeKobo: v.number(),
  },
  handler: async (ctx, { participantId, platformFeeKobo }) => {
    const participant = await ctx.db.get(participantId);
    if (!participant) throw new Error("Participant not found");
    await ctx.db.patch(participantId, { platformFeeKobo });
  },
});

/**
 * Records a Paga Checkout attempt so the callback can map its payment
 * reference back to the participant and the amount we asked Paga to charge.
 */
export const recordCheckout = internalMutation({
  args: {
    reference: v.string(),
    participantId: v.id("participants"),
    sessionId: v.id("sessions"),
    amountKobo: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("checkouts", { ...args, status: "pending" });
  },
});

/**
 * Applies a verified Paga Checkout notification (hash already checked by the
 * HTTP action). Atomic: looks up the attempt, checks the amount, marks the
 * attempt and the participant paid, and schedules the payer's receipt email.
 *
 * Returns a short outcome string for logging; never throws on bad data so the
 * callback can still answer 200 and stop Paga retrying.
 */
export const confirmCheckoutPayment = internalMutation({
  args: {
    reference: v.string(),
    amountKobo: v.number(),
  },
  handler: async (ctx, { reference, amountKobo }) => {
    const checkout = await ctx.db
      .query("checkouts")
      .withIndex("by_reference", (q) => q.eq("reference", reference))
      .unique();
    if (!checkout) return "unknown_reference";
    if (checkout.status === "paid") return "duplicate";

    if (amountKobo < checkout.amountKobo) {
      console.error(
        `Paga checkout ${reference}: paid ${amountKobo} kobo, expected ${checkout.amountKobo} — not marking paid`
      );
      return "underpaid";
    }

    const participant = await ctx.db.get(checkout.participantId);
    if (!participant) {
      console.error(`Paga checkout ${reference}: participant ${checkout.participantId} no longer exists — reconcile manually`);
      return "participant_missing";
    }

    await ctx.db.patch(checkout._id, { status: "paid" });
    const applied = await markParticipantPaid(ctx, {
      participantId: checkout.participantId,
      paymentRef: reference,
      paidAt: Date.now(),
    });
    if (!applied) return "duplicate";

    if (participant.payerEmail) {
      const session = await ctx.db.get(participant.sessionId);
      await ctx.scheduler.runAfter(0, internal.notifications.sendPayerConfirmation, {
        payerEmail: participant.payerEmail,
        payerName: participant.name,
        sessionName: session?.name ?? "Chop",
        amountKobo: participant.amountOwed,
        paymentRef: reference,
      });
    }
    return "paid";
  },
});

// ── Initiate Paga checkout ─────────────────────────────────────────────────────

/**
 * Builds a Paga Checkout payment link — the Paga keys and hash key never reach
 * the browser (only the public key, which Paga designs to be public).
 *
 * Food/bill: receives an existing participantId; amount comes from participant.amountOwed.
 * Chop-in:   receives contributorName + amountKobo; pre-inserts a pending participant
 *            row first so the callback has a stable participantId to act on.
 *
 * Returns { checkoutUrl } — redirect the user to this URL. Paga sends the payer
 * back to successUrl (charge_url) and notifies /paga/checkout-callback.
 */
export const initiateCheckout = action({
  args: {
    sessionId: v.id("sessions"),
    // Food/bill: ID of existing participant row
    participantId: v.optional(v.id("participants")),
    // Chop-in: contributor details
    contributorName: v.optional(v.string()),
    amountKobo: v.optional(v.number()),
    // Where Paga sends the user after payment (charge_reference + status_code are appended)
    successUrl: v.string(),
    // Unused by Paga Checkout (it has no cancel URL) — kept so the client call is unchanged
    cancelUrl: v.string(),
    // Payer email — required by Paga Checkout
    payerEmail: v.optional(v.string()),
    payerName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const publicKey = process.env.PAGA_PUBLIC_KEY;
    if (!publicKey) throw new Error("PAGA_PUBLIC_KEY is not configured");
    if (!args.payerEmail) throw new Error("Email is required to pay");

    // ── Block payments if organizer account is under review / suspended ─────
    const session = await ctx.runQuery(internal.sessions.getSessionById, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("Session not found");

    const organizerStatus = await ctx.runQuery(internal.sessions.getOrganizerStatus, {
      organizerId: session.organizerId,
    });
    if (organizerStatus === "under_review" || organizerStatus === "suspended") {
      throw new Error(
        "This session is temporarily unavailable. Please contact support."
      );
    }

    // ── Resolve participant and amount ──────────────────────────────────────

    let resolvedParticipantId: Id<"participants">;
    let amountDueKobo: number;

    if (args.participantId) {
      // Food / bill — participant already exists
      const participant = await ctx.runQuery(
        internal.participants.getParticipantById,
        { participantId: args.participantId }
      );
      if (!participant) throw new Error("Participant not found");
      if (participant.status === "sent") throw new Error("Already paid");
      resolvedParticipantId = args.participantId;
      amountDueKobo = participant.amountOwed; // pure share, no fee baked in
      // Store payer email on the existing participant row so the callback can use it
      await ctx.runMutation(internal.payments.internalPatchPayerEmail, {
        participantId: args.participantId,
        payerEmail: args.payerEmail,
      });
    } else {
      // Chop-in — pre-insert a pending participant row so the callback has an ID
      if (!args.amountKobo || args.amountKobo <= 0) {
        throw new Error("amountKobo required for chop-in");
      }
      if (args.amountKobo < CHOPIN_MIN_CONTRIBUTION_KOBO) {
        throw new Error("Minimum contribution is ₦100");
      }
      resolvedParticipantId = await ctx.runMutation(internal.payments.reserveChopInParticipant, {
        sessionId: args.sessionId,
        contributorName: args.contributorName ?? "Anonymous",
        amountKobo: args.amountKobo,
        payerEmail: args.payerEmail,
      });
      amountDueKobo = args.amountKobo; // pure contribution — stored as amountOwed in the pot
    }

    // ── Compute fees and checkout amount ─────────────────────────────────
    // Paga takes its processing fee out of what it collects, so both modes
    // gross up the charge — the pot still receives exactly amountDueKobo.
    let chargeAmountKobo: number;
    let feeShareKobo: number;

    if (args.participantId) {
      const allParticipants = await ctx.runQuery(
        internal.participants.getParticipantsBySessionInternal,
        { sessionId: args.sessionId }
      );
      const settlementFeeNaira = calculateSettlementFeeNaira(session.totalAmount, allParticipants.length);
      const breakdown = computeParticipantFees(amountDueKobo, session.totalAmount, settlementFeeNaira);
      chargeAmountKobo = breakdown.finalAmountKobo;
      feeShareKobo     = breakdown.feeShareKobo;
    } else {
      const chopIn = computeChopInCharge(amountDueKobo);
      chargeAmountKobo = chopIn.finalChargeKobo;
      feeShareKobo     = chopIn.platformFeeKobo;
    }

    // Store feeShareKobo on the participant row for audit/ledgering
    await ctx.runMutation(internal.payments.internalPatchPlatformFee, {
      participantId: resolvedParticipantId,
      platformFeeKobo: feeShareKobo,
    });

    // ── Record the attempt, then build the payment link ─────────────────────
    const reference = pagaReference("CHP");
    await ctx.runMutation(internal.payments.recordCheckout, {
      reference,
      participantId: resolvedParticipantId,
      sessionId: args.sessionId,
      amountKobo: chargeAmountKobo,
    });

    // Replace the action-side placeholder with the real participantId now that we
    // have it. This ensures cross-device redirects work — the ID is in the URL Paga
    // sends back, not relying on sessionStorage surviving a device switch.
    const successUrl = args.successUrl.replace(
      "__RESOLVED_BY_ACTION__",
      resolvedParticipantId
    );

    const params = new URLSearchParams({
      public_key: publicKey,
      amount: koboToNaira(chargeAmountKobo),
      currency: "NGN",
      payment_reference: reference,
      email: args.payerEmail,
      charge_url: successUrl,
      callback_url: pagaCallbackUrl(PAGA_CHECKOUT_CALLBACK_PATH),
      funding_sources: PAGA_FUNDING_SOURCES,
    });

    return {
      checkoutUrl: `${PAGA_CHECKOUT_BASE}/checkout/params?${params.toString()}`,
      checkoutId: reference,
      participantId: resolvedParticipantId,
    };
  },
});
