import { describe, expect, it } from "vitest";

import { MarketState } from "./market.js";
import { evaluateMidCurveEntry } from "./midcurve.js";
import { defaultVariants } from "./trader.js";

const T0 = 1_800_000_000_000;
const MINT = "Mid1111111111111111111111111111111111111pump";

/** Builds a standard curve that holds about 35 real SOL after 10 minutes. */
function curve(lastMinuteBuyers: number, lastMinuteSolEach: number): MarketState {
  const market = new MarketState();
  let vSol = 30;
  let vTokens = 1_073_000_000;
  const buy = (at: number, trader: string, sol: number): void => {
    const tokens = vTokens - (vSol * vTokens) / (vSol + sol);
    vSol += sol;
    vTokens -= tokens;
    market.apply(at, { txType: "buy", mint: MINT, traderPublicKey: trader, solAmount: sol, tokenAmount: tokens, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, pool: "pump" });
  };
  market.apply(T0, { txType: "create", mint: MINT, traderPublicKey: "creator", symbol: "MID", initialBuy: 0, vSolInBondingCurve: 30, vTokensInBondingCurve: 1_073_000_000, pool: "pump" });
  // 100 buyers of 0.32 SOL over the first 500 seconds: about 32 real SOL.
  for (let index = 0; index < 100; index += 1) buy(T0 + 5_000 + index * 5_000, `early-${index}`, 0.32);
  for (let index = 0; index < lastMinuteBuyers; index += 1) buy(T0 + 545_000 + index * 1_000, `late-${index}`, lastMinuteSolEach);
  return market;
}

describe("mid-curve entry rules", () => {
  it("accepts a moderate rise with broad buying in the 30 to 60 SOL range", () => {
    const decision = evaluateMidCurveEntry(curve(12, 0.2).tokens.get(MINT)!, T0 + 600_000);
    expect(decision.reasons).toEqual([]);
    expect(decision.action).toBe("enter");
    expect(decision.score).toBe(12);
  });

  it("rejects too few distinct buyers in the last minute", () => {
    expect(evaluateMidCurveEntry(curve(5, 0.5).tokens.get(MINT)!, T0 + 600_000).reasons).toContain("MID_TOO_FEW_BUYERS");
  });

  it("rejects a rise above 20% in one minute", () => {
    expect(evaluateMidCurveEntry(curve(12, 1).tokens.get(MINT)!, T0 + 600_000).reasons).toContain("MID_RETURN_OUT_OF_RANGE");
  });

  it("rejects a curve below 30 real SOL", () => {
    const market = curve(12, 0.2);
    expect(evaluateMidCurveEntry(market.tokens.get(MINT)!, T0 + 300_000).reasons).toContain("MID_REAL_SOL_OUT_OF_RANGE");
  });

  it("ignores trades at or after the decision time", () => {
    const market = curve(12, 0.2);
    expect(evaluateMidCurveEntry(market.tokens.get(MINT)!, T0 + 545_000).reasons).toContain("MID_TOO_FEW_BUYERS");
  });

  it("keeps the mid-curve portfolios paper-only with wide exits", () => {
    const variants = defaultVariants(0.5).filter((variant) => variant.strategy === "midcurve");
    expect(variants.map((variant) => variant.name)).toEqual(["mid-curve", "mid-curve-2x-costs"]);
    expect(variants[0]!.exitRules.takeProfitBps).toBe(5_000);
    expect(variants[0]!.exitRules.stopLossBps).toBe(2_000);
  });
});
