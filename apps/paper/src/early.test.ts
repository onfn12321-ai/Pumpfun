import { describe, expect, it } from "vitest";

import { evaluateEarlyEntry } from "./early.js";
import { MarketState } from "./market.js";
import { BASE_CONFIG, defaultVariants, PaperTrader } from "./trader.js";

const T0 = 1_800_000_000_000;
const MINT = "Early111111111111111111111111111111111pump";

function launch(): { market: MarketState; buy: (at: number, trader: string, sol: number) => void; sell: (at: number, trader: string, tokens: number) => void } {
  const market = new MarketState();
  let vSol = 30;
  let vTokens = 1_073_000_000;
  const buy = (at: number, trader: string, sol: number): void => {
    const tokens = vTokens - (vSol * vTokens) / (vSol + sol);
    vSol += sol;
    vTokens -= tokens;
    market.apply(at, { txType: "buy", mint: MINT, traderPublicKey: trader, solAmount: sol, tokenAmount: tokens, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, pool: "pump" });
  };
  const sell = (at: number, trader: string, tokens: number): void => {
    const sol = vSol - (vSol * vTokens) / (vTokens + tokens);
    vSol -= sol;
    vTokens += tokens;
    market.apply(at, { txType: "sell", mint: MINT, traderPublicKey: trader, solAmount: sol, tokenAmount: tokens, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, pool: "pump" });
  };
  market.apply(T0, { txType: "create", mint: MINT, traderPublicKey: "creator", symbol: "EARLY", initialBuy: 0, vSolInBondingCurve: 30, vTokensInBondingCurve: 1_073_000_000, pool: "pump" });
  // 20 distinct buyers over 100 seconds, about 4 real SOL in total.
  for (let index = 0; index < 20; index += 1) buy(T0 + 5_000 + index * 5_000, `buyer-${index}`, 0.2);
  return { market, buy, sell };
}

describe("early entry rules", () => {
  it("accepts broad, positive early buying", () => {
    const { market } = launch();
    const decision = evaluateEarlyEntry(market.tokens.get(MINT)!, T0 + 110_000);
    expect(decision.reasons).toEqual([]);
    expect(decision.action).toBe("enter");
    expect(decision.score).toBe(20);
  });

  it("rejects tokens outside the 1 to 3 minute window", () => {
    const { market } = launch();
    expect(evaluateEarlyEntry(market.tokens.get(MINT)!, T0 + 50_000).reasons).toContain("EARLY_AGE_OUT_OF_RANGE");
    expect(evaluateEarlyEntry(market.tokens.get(MINT)!, T0 + 200_000).reasons).toContain("EARLY_AGE_OUT_OF_RANGE");
  });

  it("rejects a token after the creator sells", () => {
    const { market } = launch();
    market.tokens.get(MINT)!.creatorSold = 1;
    expect(evaluateEarlyEntry(market.tokens.get(MINT)!, T0 + 110_000).reasons).toContain("EARLY_CREATOR_SOLD");
  });

  it("rejects negative recent flow", () => {
    const { market, sell } = launch();
    sell(T0 + 104_000, "buyer-0", 20_000_000);
    sell(T0 + 106_000, "buyer-1", 20_000_000);
    expect(evaluateEarlyEntry(market.tokens.get(MINT)!, T0 + 110_000).reasons).toContain("EARLY_RECENT_FLOW_NEGATIVE");
  });

  it("ignores trades at or after the decision time", () => {
    const { market, buy } = launch();
    buy(T0 + 110_000, "late", 50);
    expect(evaluateEarlyEntry(market.tokens.get(MINT)!, T0 + 110_000).reasons).not.toContain("EARLY_SINGLE_BUCKET_PUMP");
  });
});

describe("early paper portfolio", () => {
  it("enters and exits on the early stop loss within the 5 minute hold", () => {
    const { market, sell } = launch();
    const config = defaultVariants(0.5).find((variant) => variant.name === "early-entry")!;
    const trader = new PaperTrader(config, market);
    const now = T0 + 110_000;
    trader.tick(now, new Map([[MINT, "ok"]]));
    trader.advanceTo(now + config.latencyMs);
    expect(trader.positions.size).toBe(1);
    for (let index = 0; index < 10; index += 1) sell(now + 2_000 + index * 100, `buyer-${index}`, 4_000_000);
    trader.tick(now + 5_000, new Map([[MINT, "ok"]]));
    trader.advanceTo(now + 5_000 + config.latencyMs);
    expect(trader.closed).toHaveLength(1);
    expect(trader.closed[0]!.exitReasons).toContain("STOP_LOSS");
    expect(trader.closed[0]!.pnlSol).toBeLessThan(0);
  });

  it("keeps the approved portfolio on the approved strategy", () => {
    const approved = defaultVariants(0.5).find((variant) => variant.name === "approved-rules")!;
    expect(approved.strategy).toBe("momentum");
    expect(approved.exitRules).toBe(BASE_CONFIG.exitRules);
  });
});
