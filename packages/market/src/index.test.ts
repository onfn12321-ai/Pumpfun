import { describe, expect, it } from "vitest";

import { assessExecutableLiquidity, assessQuote, meetsCostHurdle } from "./index.js";

describe("market safety", () => {
  it("rejects stale quotes and identity mismatches", () => {
    const decision = assessQuote({
      mint: "wrong", side: "buy", inputAmount: 1n, expectedOutput: 2n, minimumOutput: 1n,
      quotedAt: new Date("2026-01-01T00:00:00Z"), sourceSlot: 1n, route: "bonding_curve", priceImpactBps: 1, feeLamports: 1n,
    }, { mint: "mint", side: "sell", allowedRoutes: new Set(["bonding_curve"]), now: new Date("2026-01-01T00:00:04Z") });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(["QUOTE_STALE", "QUOTE_MINT_MISMATCH", "QUOTE_SIDE_MISMATCH"]));
  });

  it("requires executable reserves and a sell simulation", () => {
    const decision = assessExecutableLiquidity({
      quoteReservesLamports: 99_000_000_000n, entryImpactBps: 10, exitImpactBps: 10, sellSimulationSucceeded: false,
      routeVerified: true, capturedAt: new Date("2026-01-01T00:00:00Z"), now: new Date("2026-01-01T00:00:01Z"),
    });
    expect(decision.reasons).toContain("INSUFFICIENT_EXECUTABLE_RESERVES");
  });

  it("blocks targets that do not clear costs and margin", () => {
    expect(meetsCostHurdle({ entryFeeBps: 100, exitFeeBps: 100, entryImpactBps: 300, exitImpactBps: 300, slippageAllowanceBps: 200, priorityFeeBps: 100, latencyCostBps: 200 }).allowed).toBe(false);
  });
});
