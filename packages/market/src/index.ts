import type { Quote, TradeSide } from "../../shared/src/index.js";

export const BPS_DENOMINATOR = 10_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const QUOTE_MAX_AGE_MS = 3_000;
export const RESERVE_MAX_AGE_MS = 5_000;
export const MAX_PRICE_IMPACT_BPS = 200;
export const MAX_CROSS_SOURCE_DIVERGENCE_BPS = 200;

export type MarketReason =
  | "QUOTE_STALE"
  | "QUOTE_FROM_FUTURE"
  | "QUOTE_MINT_MISMATCH"
  | "QUOTE_SIDE_MISMATCH"
  | "QUOTE_ROUTE_UNSUPPORTED"
  | "QUOTE_PRICE_IMPACT_TOO_HIGH"
  | "QUOTE_INVALID_OUTPUT"
  | "RESERVE_SNAPSHOT_STALE"
  | "CROSS_SOURCE_DIVERGENCE"
  | "INSUFFICIENT_EXECUTABLE_RESERVES"
  | "COST_HURDLE_NOT_MET";

export interface MarketDecision {
  allowed: boolean;
  reasons: MarketReason[];
}

export interface QuoteExpectation {
  mint: string;
  side: TradeSide;
  allowedRoutes: ReadonlySet<Quote["route"]>;
  now: Date;
  maxAgeMs?: number;
  maxPriceImpactBps?: number;
}

/**
 * Verifies the quote identity and freshness immediately before an approval.
 * A clock skew that puts a quote in the future is also unsafe, rather than
 * implicitly making it fresh.
 */
export function assessQuote(quote: Quote, expectation: QuoteExpectation): MarketDecision {
  const reasons: MarketReason[] = [];
  const ageMs = expectation.now.getTime() - quote.quotedAt.getTime();
  if (ageMs < 0) reasons.push("QUOTE_FROM_FUTURE");
  if (ageMs > (expectation.maxAgeMs ?? QUOTE_MAX_AGE_MS)) reasons.push("QUOTE_STALE");
  if (quote.mint !== expectation.mint) reasons.push("QUOTE_MINT_MISMATCH");
  if (quote.side !== expectation.side) reasons.push("QUOTE_SIDE_MISMATCH");
  if (!expectation.allowedRoutes.has(quote.route)) reasons.push("QUOTE_ROUTE_UNSUPPORTED");
  if (quote.priceImpactBps > (expectation.maxPriceImpactBps ?? MAX_PRICE_IMPACT_BPS)) {
    reasons.push("QUOTE_PRICE_IMPACT_TOO_HIGH");
  }
  if (quote.expectedOutput <= 0n || quote.minimumOutput <= 0n || quote.minimumOutput > quote.expectedOutput) {
    reasons.push("QUOTE_INVALID_OUTPUT");
  }
  return { allowed: reasons.length === 0, reasons };
}

export function isReserveSnapshotFresh(capturedAt: Date, now: Date, maxAgeMs = RESERVE_MAX_AGE_MS): MarketDecision {
  const ageMs = now.getTime() - capturedAt.getTime();
  const reasons: MarketReason[] = ageMs < 0 || ageMs > maxAgeMs ? ["RESERVE_SNAPSHOT_STALE"] : [];
  return { allowed: reasons.length === 0, reasons };
}

/** Returns ceil(numerator / denominator), preserving conservative fee sizing. */
export function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("ceilDivide requires a non-negative numerator and positive denominator");
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Calculates constant-product price impact in basis points without converting
 * token quantities to floating point. `inputReserve` and `inputAmount` must be
 * in the same base unit.
 */
export function constantProductPriceImpactBps(inputReserve: bigint, inputAmount: bigint): number {
  if (inputReserve <= 0n || inputAmount < 0n) throw new Error("reserves must be positive and input must be non-negative");
  if (inputAmount === 0n) return 0;
  // Spot output is amount * outputReserve / inputReserve; constant-product
  // output is spot output * inputReserve / (inputReserve + amount).
  const impact = ceilDivide(inputAmount * BPS_DENOMINATOR, inputReserve + inputAmount);
  return Number(impact > BPS_DENOMINATOR ? BPS_DENOMINATOR : impact);
}

export function crossSourceDivergenceBps(first: bigint, second: bigint): number {
  if (first <= 0n || second <= 0n) throw new Error("prices must be positive");
  const larger = first > second ? first : second;
  const difference = first > second ? first - second : second - first;
  return Number(ceilDivide(difference * BPS_DENOMINATOR, larger));
}

export interface ExecutableLiquidityCheck {
  quoteReservesLamports: bigint;
  entryImpactBps: number;
  exitImpactBps: number;
  sellSimulationSucceeded: boolean;
  routeVerified: boolean;
  now: Date;
  capturedAt: Date;
  minimumQuoteReservesLamports?: bigint;
  maxPriceImpactBps?: number;
}

export function assessExecutableLiquidity(input: ExecutableLiquidityCheck): MarketDecision {
  const reasons: MarketReason[] = [];
  const minimumReserves = input.minimumQuoteReservesLamports ?? 100n * LAMPORTS_PER_SOL;
  const maxImpact = input.maxPriceImpactBps ?? MAX_PRICE_IMPACT_BPS;
  if (input.quoteReservesLamports < minimumReserves || !input.sellSimulationSucceeded || !input.routeVerified) {
    reasons.push("INSUFFICIENT_EXECUTABLE_RESERVES");
  }
  if (input.entryImpactBps > maxImpact || input.exitImpactBps > maxImpact) reasons.push("QUOTE_PRICE_IMPACT_TOO_HIGH");
  const freshness = isReserveSnapshotFresh(input.capturedAt, input.now);
  reasons.push(...freshness.reasons);
  return { allowed: reasons.length === 0, reasons };
}

export interface CostHurdleInput {
  grossTargetBps?: number;
  requiredMarginBps?: number;
  entryFeeBps: number;
  exitFeeBps: number;
  entryImpactBps: number;
  exitImpactBps: number;
  slippageAllowanceBps: number;
  priorityFeeBps: number;
  latencyCostBps: number;
}

/**
 * The gross target must clear every estimated cost plus a separate safety
 * margin. All terms are bps, so no floating point SOL values enter the check.
 */
export function meetsCostHurdle(input: CostHurdleInput): MarketDecision {
  const grossTarget = input.grossTargetBps ?? 1_500;
  const margin = input.requiredMarginBps ?? 300;
  const costs = input.entryFeeBps + input.exitFeeBps + input.entryImpactBps + input.exitImpactBps
    + input.slippageAllowanceBps + input.priorityFeeBps + input.latencyCostBps;
  return costs + margin <= grossTarget
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons: ["COST_HURDLE_NOT_MET"] };
}

export function assessPriceDivergence(first: bigint, second: bigint, maxDivergenceBps = MAX_CROSS_SOURCE_DIVERGENCE_BPS): MarketDecision {
  return crossSourceDivergenceBps(first, second) <= maxDivergenceBps
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons: ["CROSS_SOURCE_DIVERGENCE"] };
}
