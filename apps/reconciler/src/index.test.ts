import { describe, expect, it } from "vitest";

import { InMemoryDurableRepository } from "../../../packages/storage/src/repository.js";
import { Reconciler } from "./index.js";

async function pendingAttempt() {
  const repository = new InMemoryDurableRepository();
  const intent = await repository.createIntent({
    logicalKey: "key", wallet: "wallet", strategyVersion: "v1", mint: "mint", side: "buy",
    signalBucket: new Date(), amountBaseUnits: 1n, reservedSol: "0.1", configHash: "config",
  });
  const created = await repository.createAttempt({ intentId: intent.id, attemptNumber: 1, messageHash: "expected-hash", signature: "expected-signature" });
  const approval = await repository.transitionAttempt(created.id, "created", "approval_pending");
  const attempt = await repository.transitionAttempt(approval.id, "approval_pending", "submitted", { signature: "expected-signature", submittedAt: new Date() });
  return { repository, pending: { intent, attempt } };
}

describe("reconciliation identity", () => {
  it("rejects a different transaction for the same wallet and mint", async () => {
    const { repository, pending } = await pendingAttempt();
    const reconciler = new Reconciler(repository, { findAttempt: async () => ({
      signature: "other-signature", messageHash: "other-hash", commitment: "finalized", failed: false,
      mint: "mint", wallet: "wallet", tokenDelta: 1n, solDelta: "-0.1", feeLamports: 1n, instructionIndex: 0,
    }) });
    expect(await reconciler.reconcileOne(pending)).toBe("mismatch");
    expect(pending.attempt.state).toBe("submitted");
  });

  it("accepts a matching message identity", async () => {
    const { repository, pending } = await pendingAttempt();
    const reconciler = new Reconciler(repository, { findAttempt: async () => ({
      signature: "other-signature", messageHash: "expected-hash", commitment: "finalized", failed: false,
      mint: "mint", wallet: "wallet", tokenDelta: 1n, solDelta: "-0.1", feeLamports: 1n, instructionIndex: 0,
    }) });
    expect(await reconciler.reconcileOne(pending)).toBe("finalized");
  });
});
