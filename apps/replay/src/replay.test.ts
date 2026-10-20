import { describe, expect, it } from "vitest";

import { replayHistorical } from "./replay.js";

describe("historical replay", () => {
  it("releases a timely event only after its bucket closes", () => {
    const event = {
      eventId: "event", mint: "mint", source: "rpc" as const, slot: 1n, signature: "sig", instructionIndex: 0,
      chainTime: new Date("2026-01-01T00:00:01Z"), observedAt: new Date("2026-01-01T00:00:02Z"), commitment: "confirmed" as const,
      rawPayloadRef: "fixture", decoderVersion: "v1", kind: "trade" as const,
      trade: { side: "buy" as const, priceSol: 1, volumeSol: 1, buyer: "buyer" },
    };
    const result = replayHistorical([event], [], () => ({ action: "hold", reasons: [] }));
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]!.availableAt.toISOString()).toBe("2026-01-01T00:00:05.000Z");
    expect(result.decisions[0]!.decision.action).toBe("blocked");
  });
});
