/**
 * Shared fee constants and computation helpers.
 *
 * Single source of truth for ALL fee math in the Chop backend.
 * The frontend mirrors these in frontend/src/lib/fees.ts — keep in sync.
 *
 * Fee model (food & bill only — chop-in is separate):
 *   Settlement fee  = dynamic (participant-count + amount based), capped ₦800
 *   Processing fee  = 1.5% gross-up so the pot receives exactly the principal
 *                     (Paga takes its fee from what it collects, so we charge on top)
 *   Withdrawal      = ₦50 flat (Paga bank transfer fee) — deducted from pot at payout
 *
 * The TARGET AMOUNT (pot) is always 100% intact.
 * All fees are borne by the participant on top of their share.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const SMALL_GROUP_LIMIT    = 7;
export const SMALL_GROUP_FEE      = 70;    // ₦70 flat (naira)
export const PER_PERSON_FEE       = 10;    // ₦10 per person (naira)
export const PERCENTAGE_RATE      = 0.004; // 0.4% of target amount
export const MINIMUM_FEE_NAIRA    = 70;    // ₦70 minimum
export const MAXIMUM_FEE_NAIRA    = 800;   // ₦800 hard cap
export const PROCESSING_RATE      = 0.015; // 1.5% gross-up — Paga Checkout fee
export const TRANSFER_FEE_KOBO    = 5_000;    // ₦50 flat payout fee
/** Below this collected amount, the ₦50 transfer fee is charged to the organiser */
export const CHOPIN_FEE_THRESHOLD_KOBO    = 500_000;  // ₦5,000
/** Minimum contribution allowed for chop-in (₦100) */
export const CHOPIN_MIN_CONTRIBUTION_KOBO = 10_000;   // ₦100

// ── Settlement fee (food & bill) ──────────────────────────────────────────────

/**
 * Calculates the total settlement fee in NAIRA (whole naira, ceiling).
 *
 * @param targetAmountKobo  — total bill / pot in kobo
 * @param participantCount  — number of participants
 */
export function calculateSettlementFeeNaira(
  targetAmountKobo: number,
  participantCount: number
): number {
  const targetNaira = targetAmountKobo / 100;

  let fee = participantCount <= SMALL_GROUP_LIMIT
    ? SMALL_GROUP_FEE
    : participantCount * PER_PERSON_FEE;

  const percentageFee = targetNaira * PERCENTAGE_RATE;
  fee = Math.max(fee, percentageFee);
  fee = Math.max(fee, MINIMUM_FEE_NAIRA);
  fee = Math.min(fee, MAXIMUM_FEE_NAIRA);

  return Math.ceil(fee); // whole naira, always round up
}

// ── Per-participant breakdown ──────────────────────────────────────────────────

export interface ParticipantFeeBreakdown {
  /** Pure bill share — goes to the pot intact */
  principalShareKobo: number;
  /** This person's proportional share of the settlement fee (kobo) */
  feeShareKobo: number;
  /** Paga 1.5% gross-up charged on top (kobo, estimated) */
  processingFeeKobo: number;
  /** What the participant actually taps "Pay" for (kobo) */
  finalAmountKobo: number;
}

/**
 * Computes per-participant fee breakdown for food & bill modes.
 *
 * @param principalShareKobo   — this person's share of the bill (kobo)
 * @param targetAmountKobo     — total session amount (kobo) — used for proportion
 * @param settlementFeeNaira   — total settlement fee (naira) from calculateSettlementFeeNaira
 */
export function computeParticipantFees(
  principalShareKobo: number,
  targetAmountKobo: number,
  settlementFeeNaira: number
): ParticipantFeeBreakdown {
  const proportion = targetAmountKobo > 0 ? principalShareKobo / targetAmountKobo : 0;
  // Round up to the nearest whole naira (100 kobo) so the final charge is always
  // a clean whole-naira amount before the processing gross-up.
  const feeShareKobo = Math.ceil(proportion * settlementFeeNaira) * 100;

  // Amount we need Paga to pass through to the pot (principal + our fee)
  const amountBeforeProcessingKobo = principalShareKobo + feeShareKobo;

  // Gross-up: Net / (1 - 0.015) so Paga's 1.5% doesn't eat into the amount
  const finalAmountKobo = Math.ceil(amountBeforeProcessingKobo / (1 - PROCESSING_RATE));

  const processingFeeKobo = finalAmountKobo - amountBeforeProcessingKobo;

  return {
    principalShareKobo,
    feeShareKobo,
    processingFeeKobo,
    finalAmountKobo,
  };
}

// ── Chop-in contribution fee ───────────────────────────────────────────────────

/**
 * Platform fee for a chop-in contribution, in whole naira (Math.ceil).
 *
 * Tiers:
 *   ₦100 – ₦499      → flat ₦10
 *   ₦500 – ₦5,000    → linear ₦20 → ₦50  (formula: 20 + (amount - 500) × 30/4500)
 *   above ₦5,000     → 1% of amount, min ₦50, max ₦1,000
 *
 * Tier 2 includes ₦5,000 exactly (fee = ₦50). Tier 3 starts strictly above ₦5,000.
 *
 * @param contributionNaira — desired contribution in naira (not kobo)
 */
export function calculateChopInPlatformFeeNaira(contributionNaira: number): number {
  if (contributionNaira <= 0) return 0;

  if (contributionNaira < 500) {
    // Tier 1: ₦100 – ₦499
    return 10;
  }

  if (contributionNaira <= 5_000) {
    // Tier 2: ₦500 – ₦5,000 inclusive
    const fee = 20 + (contributionNaira - 500) * (30 / 4_500);
    return Math.ceil(fee);
  }

  // Tier 3: above ₦5,000
  const fee = contributionNaira * 0.01;
  return Math.min(1_000, Math.max(50, Math.ceil(fee)));
}

/**
 * Charge breakdown for a chop-in contribution.
 *
 * Paga takes its processing fee out of what it collects, so we gross up
 * (contribution + platformFee) by PROCESSING_RATE — the pot still receives
 * exactly the contribution.
 *
 * contributionKobo  — pure amount that reaches the pot (stored as amountOwed)
 *
 * Returns:
 *   platformFeeKobo    — our platform fee in kobo (whole-naira multiple)
 *   processingFeeKobo  — Paga's fee, charged on top (kobo)
 *   finalChargeKobo    — amount sent to Paga Checkout
 */
export function computeChopInCharge(contributionKobo: number): {
  platformFeeKobo: number;
  processingFeeKobo: number;
  finalChargeKobo: number;
} {
  const contributionNaira = contributionKobo / 100;
  const platformFeeNaira  = calculateChopInPlatformFeeNaira(contributionNaira);
  const platformFeeKobo   = platformFeeNaira * 100; // already whole naira from ceil

  const amountBeforeProcessingKobo = contributionKobo + platformFeeKobo;
  const finalChargeKobo   = Math.ceil(amountBeforeProcessingKobo / (1 - PROCESSING_RATE));
  const processingFeeKobo = finalChargeKobo - amountBeforeProcessingKobo;

  return { platformFeeKobo, processingFeeKobo, finalChargeKobo };
}
