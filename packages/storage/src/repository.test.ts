import { describe, expect, it } from "vitest";

import { DuplicateLogicalIntentError, InMemoryDurableRepository } from "./repository.js";

describe("durable repository", () => {
  it("enforces logical intent idempotency", async () => {
    const repository = new InMemoryDurableRepository();
    const input = { logicalKey: "wallet:strategy:mint:buy:bucket", wallet: "wallet", strategyVersion: "v1", mint: "mint", side: "buy" as const, signalBucket: new Date(), amountBaseUnits: 1n, reservedSol: "0.1", configHash: "config" };
    await repository.createIntent(input);
    await expect(repository.createIntent(input)).rejects.toBeInstanceOf(DuplicateLogicalIntentError);
  });

  it("rejects stale state transitions", async () => {
    const repository = new InMemoryDurableRepository();
    const intent = await repository.createIntent({ logicalKey: "key", wallet: "wallet", strategyVersion: "v1", mint: "mint", side: "buy", signalBucket: new Date(), amountBaseUnits: 1n, reservedSol: "0.1", configHash: "config" });
    await repository.transitionIntent(intent.id, "created", "reserved", 0);
    await expect(repository.transitionIntent(intent.id, "created", "reserved", 0)).rejects.toThrow(/Revision conflict/);
  });
});
