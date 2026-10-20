import { describe, expect, it } from "vitest";

import { assessHistoricalGate, evaluateTrades } from "./index.js";

describe("evaluation", () => {
  it("includes losses and execution costs", () => {
    const metrics = evaluateTrades([
      { mint: "a", openedAt: new Date(0), closedAt: new Date(1), netPnlLamports: 20n, capitalLamports: 100n, feesLamports: 2n, slippageLamports: 1n, failedAttempts: 0 },
      { mint: "b", openedAt: new Date(2), closedAt: new Date(3), netPnlLamports: -10n, capitalLamports: 100n, feesLamports: 2n, slippageLamports: 3n, failedAttempts: 1 },
    ]);
    expect(metrics.netPnlLamports).toBe(10n);
    expect(metrics.profitFactor).toBe(2);
    expect(metrics.totalCostsLamports).toBe(8n);
    expect(metrics.failedAttempts).toBe(1);
  });

  it("blocks insufficient evidence", () => {
    const metrics = evaluateTrades([]);
    const gate = assessHistoricalGate(metrics, 2, 0n, -1n);
    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain("CLOSED_TRADES_BELOW_200");
  });
});
