import { describe, expect, it } from "vitest";

import { buildFiveSecondBuckets } from "./buckets.js";
import { MarketEventCapture } from "./capture.js";
import type { CanonicalMarketEvent } from "./types.js";

function trade(overrides: Partial<CanonicalMarketEvent> = {}): CanonicalMarketEvent {
  return {
    eventId: "event-1", mint: "mint", source: "rpc", slot: 10n, signature: "signature", instructionIndex: 0,
    chainTime: new Date("2026-01-01T00:00:01Z"), observedAt: new Date("2026-01-01T00:00:02Z"), commitment: "confirmed",
    rawPayloadRef: "fixture", decoderVersion: "v1", kind: "trade", trade: { side: "buy", priceSol: 1, volumeSol: 2, buyer: "buyer" },
    ...overrides,
  };
}

describe("market capture", () => {
  it("deduplicates chain identity", () => {
    const capture = new MarketEventCapture();
    expect(capture.ingest(trade()).accepted).toBe(true);
    expect(capture.ingest(trade({ eventId: "event-2" })).duplicate).toBe(true);
  });

  it("does not include observations from the future", () => {
    const event = trade({ observedAt: new Date("2026-01-01T00:00:10Z") });
    expect(buildFiveSecondBuckets([event], { availableAt: new Date("2026-01-01T00:00:09Z") })).toEqual([]);
  });
});
