import { describe, expect, it } from "vitest";

import type { MarketBucket } from "../../shared/src/index.js";
import { evaluateExit, evaluateMomentumEntry } from "./index.js";

function buckets(): MarketBucket[] {
  const start = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: 60 }, (_, index) => {
    const openProgress = index < 48 ? (index / 48) * 0.05 : 0.05 + ((index - 48) / 12) * 0.05;
    const closeIndex = index + 1;
    const closeProgress = closeIndex < 48 ? (closeIndex / 48) * 0.05 : 0.05 + ((closeIndex - 48) / 12) * 0.05;
    const open = 1 + openProgress;
    const close = 1 + closeProgress;
    return {
      mint: "mint", startedAt: new Date(start + index * 5_000), closedAt: new Date(start + (index + 1) * 5_000),
      openPriceSol: open, closePriceSol: close, highPriceSol: close, lowPriceSol: open,
      buyVolumeSol: index >= 48 ? 1.5 : 0.5, sellVolumeSol: index >= 48 ? 0.5 : 0.2, distinctBuyers: 1,
    };
  });
}

describe("momentum strategy", () => {
  it("enters only when every deterministic threshold passes", () => {
    const decisionAt = new Date("2026-01-01T00:05:00Z");
    const decision = evaluateMomentumEntry({ mint: "mint", tokenCreatedAt: new Date("2025-12-31T23:50:00Z"), decisionAt, completedBuckets: buckets(), distinctBuyers5m: 30 });
    expect(decision.action).toBe("enter");
  });

  it("uses executable net value for exits", () => {
    const decision = evaluateExit({ netExecutableValueLamports: 91n, entryCostLamports: 100n, peakNetExecutableValueLamports: 110n, openedAt: new Date(0), now: new Date(1) });
    expect(decision.action).toBe("exit");
    expect(decision.reasons).toContain("STOP_LOSS");
  });
});
