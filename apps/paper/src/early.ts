import { BUCKET_MS, INITIAL_VIRTUAL_SOL, priceOf, type TokenState } from "./market.js";

/**
 * Early-entry rules for paper observation only. A token qualifies 1 to 3
 * minutes after launch when buying is broad, net flow is still positive, the
 * creator has not sold, and the curve has not already run far. The values were
 * chosen from first principles before any backtest, not fitted to data.
 */
export interface EarlyEntryRules {
  minAgeMs: number;
  maxAgeMs: number;
  minTrades: number;
  minDistinctBuyers: number;
  minBuyVolumeShareBps: number;
  recentWindowMs: number;
  minRecentBuys: number;
  minRealSol: number;
  maxRealSol: number;
  maxFiveSecondReturnBps: number;
}

export const EARLY_ENTRY_RULES: Readonly<EarlyEntryRules> = Object.freeze({
  minAgeMs: 60_000,
  maxAgeMs: 180_000,
  minTrades: 15,
  minDistinctBuyers: 10,
  minBuyVolumeShareBps: 6_500,
  recentWindowMs: 30_000,
  minRecentBuys: 3,
  minRealSol: 2,
  maxRealSol: 20,
  maxFiveSecondReturnBps: 4_000,
});

export type EarlyRejection =
  | "EARLY_AGE_OUT_OF_RANGE"
  | "EARLY_TOO_FEW_TRADES"
  | "EARLY_TOO_FEW_BUYERS"
  | "EARLY_BUY_SHARE_TOO_LOW"
  | "EARLY_RECENT_FLOW_NEGATIVE"
  | "EARLY_REAL_SOL_OUT_OF_RANGE"
  | "EARLY_CREATOR_SOLD"
  | "EARLY_SINGLE_BUCKET_PUMP";

export interface EarlyDecision {
  action: "enter" | "skip";
  reasons: EarlyRejection[];
  /** Ranks candidates: more distinct buyers first. */
  score: number;
}

/** Uses only trades observed strictly before `now`. */
export function evaluateEarlyEntry(token: TokenState, now: number, rules: Readonly<EarlyEntryRules> = EARLY_ENTRY_RULES): EarlyDecision {
  const reasons: EarlyRejection[] = [];
  const age = now - token.createdAt;
  if (age < rules.minAgeMs || age > rules.maxAgeMs) reasons.push("EARLY_AGE_OUT_OF_RANGE");

  const trades = token.trades.filter((trade) => trade.at < now);
  if (trades.length < rules.minTrades) reasons.push("EARLY_TOO_FEW_TRADES");

  const buyers = new Set(trades.filter((trade) => trade.side === "buy").map((trade) => trade.trader));
  if (buyers.size < rules.minDistinctBuyers) reasons.push("EARLY_TOO_FEW_BUYERS");

  let buySol = 0;
  let sellSol = 0;
  for (const trade of trades) {
    if (trade.side === "buy") buySol += trade.sol;
    else sellSol += trade.sol;
  }
  const total = buySol + sellSol;
  if (total <= 0 || (buySol / total) * 10_000 < rules.minBuyVolumeShareBps) reasons.push("EARLY_BUY_SHARE_TOO_LOW");

  const recent = trades.filter((trade) => trade.at >= now - rules.recentWindowMs);
  const recentBuys = recent.filter((trade) => trade.side === "buy");
  const recentNet = recent.reduce((sum, trade) => sum + (trade.side === "buy" ? trade.sol : -trade.sol), 0);
  if (recentBuys.length < rules.minRecentBuys || recentNet <= 0) reasons.push("EARLY_RECENT_FLOW_NEGATIVE");

  const realSol = token.vSol - INITIAL_VIRTUAL_SOL;
  if (realSol < rules.minRealSol || realSol > rules.maxRealSol) reasons.push("EARLY_REAL_SOL_OUT_OF_RANGE");

  if (token.creatorSold > 0) reasons.push("EARLY_CREATOR_SOLD");

  if (largestRecentBucketReturnBps(trades, now) > rules.maxFiveSecondReturnBps) reasons.push("EARLY_SINGLE_BUCKET_PUMP");

  return { action: reasons.length === 0 ? "enter" : "skip", reasons, score: buyers.size };
}

/** Largest close-to-close return across 5 second buckets in the last minute. */
function largestRecentBucketReturnBps(trades: readonly TokenState["trades"][number][], now: number): number {
  const start = now - 60_000;
  let previousClose: number | undefined;
  const before = trades.filter((trade) => trade.at < start);
  const last = before[before.length - 1];
  if (last) previousClose = priceOf(last.vSol, last.vTokens);
  let largest = 0;
  for (let bucketStart = start; bucketStart < now; bucketStart += BUCKET_MS) {
    const inBucket = trades.filter((trade) => trade.at >= bucketStart && trade.at < bucketStart + BUCKET_MS);
    const close = inBucket[inBucket.length - 1];
    if (!close) continue;
    const price = priceOf(close.vSol, close.vTokens);
    if (previousClose !== undefined && previousClose > 0) largest = Math.max(largest, ((price - previousClose) / previousClose) * 10_000);
    previousClose = price;
  }
  return largest;
}
