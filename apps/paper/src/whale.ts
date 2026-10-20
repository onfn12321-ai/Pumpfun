import { INITIAL_VIRTUAL_SOL, type TokenState } from "./market.js";

/**
 * Late whale rules for paper observation only. A token qualifies right after a
 * wallet makes its first buy of at least 4 SOL in that token while the curve
 * holds 50 to 84 real SOL. The position is sold after 5 minutes.
 *
 * In the hypothesis search on about 22 hours of recorded mainnet data, this was
 * the only rule set with a positive mean (+4.3% per trade over 108 trades).
 * It failed the checks: one of three time periods lost money and the bootstrap
 * 5th percentile was negative. The evidence is weak and can be chance.
 */
export interface WhaleRules {
  minBuySol: number;
  minRealSol: number;
  maxRealSol: number;
  minAgeMs: number;
  /** The whale buy must be this recent when the trader evaluates the token. */
  signalWindowMs: number;
}

export const WHALE_RULES: Readonly<WhaleRules> = Object.freeze({
  minBuySol: 4,
  minRealSol: 50,
  maxRealSol: 84,
  minAgeMs: 30_000,
  signalWindowMs: 10_000,
});

export interface WhaleDecision {
  action: "enter" | "skip";
  /** Size of the qualifying buy in SOL. */
  score: number;
}

/** Uses only trades observed strictly before `now`. */
export function evaluateWhaleEntry(token: TokenState, now: number, rules: Readonly<WhaleRules> = WHALE_RULES): WhaleDecision {
  const seen = new Set<string>();
  let best = 0;
  for (const trade of token.trades) {
    if (trade.at >= now) break;
    const first = !seen.has(trade.trader);
    seen.add(trade.trader);
    if (!first || trade.side !== "buy" || trade.sol < rules.minBuySol || now - trade.at > rules.signalWindowMs) continue;
    if (trade.at - token.createdAt < rules.minAgeMs) continue;
    const realSol = trade.vSol - INITIAL_VIRTUAL_SOL;
    if (realSol < rules.minRealSol || realSol >= rules.maxRealSol) continue;
    best = Math.max(best, trade.sol);
  }
  return { action: best > 0 ? "enter" : "skip", score: best };
}
