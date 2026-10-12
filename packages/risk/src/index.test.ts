import { describe, expect, it } from "vitest";

import { assessEntryRisk, mustHaltForDailyLoss, type RiskLimits, type RiskState } from "./index.js";

const limits: RiskLimits = {
  maxPositionBps: 25,
  maxDailyLossBps: 100,
  maxExposureBps: 200,
  feeReserveLamports: 50n,
};

const state: RiskState = {
  currentEquityLamports: 100_000n,
  openingEquityLamports: 120_000n,
  externalFlowsLamports: 0n,
  availableCashLamports: 10_000n,
  currentExposureLamports: 0n,
  unresolvedExposureLamports: 0n,
  netPnlLamports: 0n,
  entryHalt: false,
  executionHalt: false,
  hasUnpriceableAsset: false,
};

describe("entry risk", () => {
  it("uses the smaller current and opening equity", () => {
    const result = assessEntryRisk(limits, state, { principalLamports: 250n, worstCaseFeesLamports: 10n, worstCaseSlippageLamports: 5n });
    expect(result.allowed).toBe(true);
    expect(result.sizingEquityLamports).toBe(100_000n);
  });

  it("counts unresolved intents against exposure", () => {
    const result = assessEntryRisk(limits, { ...state, unresolvedExposureLamports: 1_980n }, { principalLamports: 25n, worstCaseFeesLamports: 0n, worstCaseSlippageLamports: 0n });
    expect(result.reasons).toContain("EXPOSURE_LIMIT");
  });

  it("halts at the configured daily loss boundary", () => {
    expect(mustHaltForDailyLoss(limits, 100_000n, 0n, -1_000n)).toBe(true);
  });

  it("rejects approved ceiling violations", () => {
    expect(() => assessEntryRisk({ ...limits, maxPositionBps: 501 }, state, { principalLamports: 1n, worstCaseFeesLamports: 0n, worstCaseSlippageLamports: 0n })).toThrow(/ceilings/);
  });
});
