import type { DurableRepository, PendingAttempt } from "../../../packages/storage/src/repository.js";

export interface ChainTransaction {
  signature: string;
  messageHash: string;
  commitment: "confirmed" | "finalized";
  failed: boolean;
  mint: string;
  wallet: string;
  tokenDelta: bigint;
  solDelta: string;
  feeLamports: bigint;
  instructionIndex: number;
}

export interface ReconciliationRpc {
  findAttempt(attempt: PendingAttempt): Promise<ChainTransaction | "expired" | null>;
}

export type ReconciliationResult = "pending" | "expired" | "failed" | "confirmed" | "finalized" | "mismatch";

export class Reconciler {
  constructor(private readonly repository: DurableRepository, private readonly rpc: ReconciliationRpc) {}

  async reconcileOne(pending: PendingAttempt): Promise<ReconciliationResult> {
    const chain = await this.rpc.findAttempt(pending);
    if (chain === null) return "pending";
    if (chain === "expired") {
      await this.repository.transitionAttempt(pending.attempt.id, pending.attempt.state, "expired");
      return "expired";
    }
    const signatureMatches = pending.attempt.signature !== null && chain.signature === pending.attempt.signature;
    const messageMatches = pending.attempt.messageHash !== null && chain.messageHash === pending.attempt.messageHash;
    if (
      chain.wallet !== pending.intent.wallet
      || chain.mint !== pending.intent.mint
      || (!signatureMatches && !messageMatches)
    ) return "mismatch";
    if (chain.failed) {
      await this.repository.transitionAttempt(pending.attempt.id, pending.attempt.state, "failed", { error: "chain transaction failed" });
      return "failed";
    }
    await this.repository.recordFill({
      signature: chain.signature,
      instructionIndex: chain.instructionIndex,
      intentId: pending.intent.id,
      mint: chain.mint,
      tokenDelta: chain.tokenDelta,
      solDelta: chain.solDelta,
      feeBreakdown: { networkFeeLamports: chain.feeLamports.toString() },
      commitment: chain.commitment,
      observedAt: new Date(),
    });
    if (chain.commitment === "finalized") {
      await this.repository.transitionAttempt(pending.attempt.id, pending.attempt.state, "finalized", { finalizedAt: new Date(), signature: chain.signature });
      return "finalized";
    }
    await this.repository.transitionAttempt(pending.attempt.id, pending.attempt.state, "confirmed", { confirmedAt: new Date(), signature: chain.signature });
    return "confirmed";
  }

  async runOnce(): Promise<ReconciliationResult[]> {
    const pending = await this.repository.listPendingAttempts();
    const results: ReconciliationResult[] = [];
    for (const attempt of pending) results.push(await this.reconcileOne(attempt));
    return results;
  }
}
