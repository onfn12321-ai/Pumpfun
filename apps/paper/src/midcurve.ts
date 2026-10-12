import { INITIAL_VIRTUAL_SOL, priceOf, type TokenState } from "./market.js";

/**
 * Mid-curve rules for paper observation only. A token qualifies when the
 * curve holds 30 to 60 real SOL, the price rose a moderate 3% to 20% in the
 * last minute, and at least 10 distinct wallets bought in that minute.
 *
 * These values came from a search over about 2.5 hours of recorded mainnet
 * data. The search tested 4,655 rule sets and this one was among the few that
 * stayed positive on held-out data, at about +1% to +2.5% per trade with a
 * median trade near -20%. The evidence is weak and can be chance.
 */
export interface MidCurveRules {
  minRealSol: number;
  maxRealSol: number;
  windowMs: number;
  minReturnBps: number;
  maxReturnBps: number;
  minDistinctBuyers: number;
}

export const MID_CURVE_RULES: Readonly<MidCurveRules> = Object.freeze({
  minRealSol: 30,
  maxRealSol: 60,
  windowMs: 60_000,
  minReturnBps: 300,
  maxReturnBps: 2_000,
  minDistinctBuyers: 10,
});

export type MidCurveRejection = "MID_REAL_SOL_OUT_OF_RANGE" | "MID_NO_PRICE_HISTORY" | "MID_RETURN_OUT_OF_RANGE" | "MID_TOO_FEW_BUYERS";

export interface MidCurveDecision {
  action: "enter" | "skip";
  reasons: MidCurveRejection[];
  /** Ranks candidates: more distinct buyers first. */
  score: number;
}

/** Uses only trades observed strictly before `now`. */
export function evaluateMidCurveEntry(token: TokenState, now: number, rules: Readonly<MidCurveRules> = MID_CURVE_RULES): MidCurveDecision {
  const reasons: MidCurveRejection[] = [];
  const trades = token.trades.filter((trade) => trade.at < now);
  const last = trades[trades.length - 1];
  const realSol = (last ? last.vSol : token.vSol) - INITIAL_VIRTUAL_SOL;
  if (realSol < rules.minRealSol || realSol > rules.maxRealSol) reasons.push("MID_REAL_SOL_OUT_OF_RANGE");

  const start = now - rules.windowMs;
  const before = trades.filter((trade) => trade.at < start);
  const reference = before[before.length - 1];
  if (!last || !reference) {
    reasons.push("MID_NO_PRICE_HISTORY");
  } else {
    const returnBps = (priceOf(last.vSol, last.vTokens) / priceOf(reference.vSol, reference.vTokens) - 1) * 10_000;
    if (returnBps < rules.minReturnBps || returnBps >= rules.maxReturnBps) reasons.push("MID_RETURN_OUT_OF_RANGE");
  }

  const buyers = new Set(trades.filter((trade) => trade.at >= start && trade.side === "buy").map((trade) => trade.trader));
  if (buyers.size < rules.minDistinctBuyers) reasons.push("MID_TOO_FEW_BUYERS");

  return { action: reasons.length === 0 ? "enter" : "skip", reasons, score: buyers.size };
}
