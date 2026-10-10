import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { BrowserTradeExecutor } from "./executor.js";
import { FakePumpUiAdapter, FakeWalletAdapter, InMemoryExecutionRepository, fakeTermsAuthorization } from "./fakes.js";
import { enforceTransactionPolicy } from "./transaction-policy.js";
import type { TradeRequest } from "./types.js";

function transactionBytes(payer: Keypair, destination: Keypair): Uint8Array {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destination.publicKey, lamports: 1 }),
  );
  tx.sign(payer);
  return tx.serialize();
}

describe("transaction policy", () => {
  it("rejects an unknown writable destination", () => {
    const payer = Keypair.generate();
    const destination = Keypair.generate();
    expect(() => enforceTransactionPolicy([transactionBytes(payer, destination)], {
      expectedSigner: payer.publicKey.toBase58(),
      allowedProgramIds: new Set([SystemProgram.programId.toBase58()]),
      allowedWritableAccounts: new Set(),
      maximumTransactions: 1,
    })).toThrow(/Unexpected writable account/);
  });
});

describe("browser executor", () => {
  it("blocks live approval without a current authorization record", async () => {
    const payer = Keypair.generate();
    const destination = Keypair.generate();
    const bytes = transactionBytes(payer, destination);
    const repository = new InMemoryExecutionRepository();
    repository.seed({ id: "attempt", intentId: "intent", attemptNumber: 1, state: "policy_checked" });
    const wallet = new FakeWalletAdapter(
      { inspectedSerializedTransactions: true, messageDigestBinding: true },
      { requestId: "wallet-request", serializedTransactions: [bytes] },
    );
    const now = new Date("2026-01-01T00:00:02Z");
    const request: TradeRequest = {
      intent: { id: "intent", logicalKey: "key", wallet: payer.publicKey.toBase58(), mint: "mint", side: "buy", amountLamports: 1n, signalBucket: now, configHash: "config" },
      quote: { mint: "mint", side: "buy", inputAmount: 1n, expectedOutput: 2n, minimumOutput: 1n, quotedAt: now, sourceSlot: 1n, reserveSnapshotSlot: 1n, route: "bonding_curve", priceImpactBps: 1, feeLamports: 1n },
      expectedOrigin: "https://pump.fun",
      slippageBps: 100,
    };
    const executor = new BrowserTradeExecutor(repository, new FakePumpUiAdapter({
      origin: request.expectedOrigin,
      wallet: request.intent.wallet,
      mint: request.intent.mint,
      side: request.intent.side,
      inputAmount: request.intent.amountLamports,
      route: request.quote.route,
      minimumOutput: request.quote.minimumOutput,
      slippageBps: request.slippageBps,
    }), wallet, { now: () => now });
    await expect(executor.execute({ request, attemptId: "attempt", termsAuthorization: null, transactionPolicy: {
      expectedSigner: payer.publicKey.toBase58(),
      allowedProgramIds: new Set([SystemProgram.programId.toBase58()]),
      allowedWritableAccounts: new Set([destination.publicKey.toBase58()]),
      maximumTransactions: 1,
    } })).rejects.toThrow(/authorization/);
    expect(fakeTermsAuthorization(payer.publicKey.toBase58())).toBeTruthy();
  });
});
