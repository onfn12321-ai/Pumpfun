import { describe, expect, it } from "vitest";

import { MarketState } from "./market.js";
import { defaultVariants } from "./trader.js";
import { evaluateWhaleEntry } from "./whale.js";

const T0 = 1_800_000_000_000;
const MINT = "Whale111111111111111111111111111111111111pump";

/** Fills a standard curve to about 55 real SOL, then adds one buy by `wallet`. */
function curve(wallet: string, sol: number, at = T0 + 600_000): MarketState {
  const market = new MarketState();
  let vSol = 30;
  let vTokens = 1_073_000_000;
  const buy = (time: number, trader: string, amount: number): void => {
    const tokens = vTokens - (vSol * vTokens) / (vSol + amount);
    vSol += amount;
    vTokens -= tokens;
    market.apply(time, { txType: "buy", mint: MINT, traderPublicKey: trader, solAmount: amount, tokenAmount: tokens, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, pool: "pump" });
  };
  market.apply(T0, { txType: "create", mint: MINT, traderPublicKey: "creator", symbol: "WHL", initialBuy: 0, vSolInBondingCurve: 30, vTokensInBondingCurve: 1_073_000_000, pool: "pump" });
  for (let index = 0; index < 110; index += 1) buy(T0 + 5_000 + index * 5_000, index === 3 ? "repeat" : `small-${index}`, 0.5);
  buy(at, wallet, sol);
  return market;
}

describe("late whale entry rules", () => {
  it("enters right after a first 4 SOL buy above 50 real SOL", () => {
    expect(evaluateWhaleEntry(curve("whale", 4.5).tokens.get(MINT)!, T0 + 605_000)).toEqual({ action: "enter", score: 4.5 });
  });

  it("skips a buy below 4 SOL", () => {
    expect(evaluateWhaleEntry(curve("whale", 3).tokens.get(MINT)!, T0 + 605_000).action).toBe("skip");
  });

  it("skips a wallet that already traded the token", () => {
    expect(evaluateWhaleEntry(curve("repeat", 5).tokens.get(MINT)!, T0 + 605_000).action).toBe("skip");
  });

  it("skips a stale signal and ignores trades at or after the decision time", () => {
    const token = curve("whale", 5).tokens.get(MINT)!;
    expect(evaluateWhaleEntry(token, T0 + 615_000).action).toBe("skip");
    expect(evaluateWhaleEntry(token, T0 + 600_000).action).toBe("skip");
  });

  it("keeps the whale portfolios paper-only with a 5 minute time exit", () => {
    const variants = defaultVariants(0.5).filter((variant) => variant.strategy === "whale");
    expect(variants.map((variant) => variant.name)).toEqual(["whale-late", "whale-late-2x-costs"]);
    expect(variants[0]!.exitRules.maxHoldMs).toBe(300_000);
  });
});
