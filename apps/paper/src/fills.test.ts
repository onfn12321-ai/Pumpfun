import { describe, expect, it } from "vitest";

import { executePaperOrder } from "./fills.js";

describe("paper fills", () => {
  it("uses only quotes visible at modeled execution", () => {
    const submittedAt = new Date("2026-01-01T00:00:00Z");
    const result = executePaperOrder(
      { id: "order", mint: "mint", side: "buy", inputAmount: 100n, submittedAt, maxSlippageBps: 100 },
      [
        { mint: "mint", side: "buy", inputAmount: 100n, expectedOutput: 200n, feeAmount: 1n, priceImpactBps: 10, observedAt: new Date("2026-01-01T00:00:00.100Z"), sourceSlot: 1n, route: "bonding_curve" },
        { mint: "mint", side: "buy", inputAmount: 100n, expectedOutput: 300n, feeAmount: 1n, priceImpactBps: 10, observedAt: new Date("2026-01-01T00:00:02Z"), sourceSlot: 2n, route: "bonding_curve" },
      ],
      { buyLatencyMs: 500, sellLatencyMs: 500, networkFeeLamports: 1n, priorityFeeLamports: 1n, latencySlippageBps: 10, maxQuoteAgeMs: 1_000 },
    );
    expect(result.status).toBe("filled");
    expect(result.quote?.sourceSlot).toBe(1n);
  });
});
