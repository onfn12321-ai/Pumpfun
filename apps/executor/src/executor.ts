import { createHash } from "node:crypto";

import { assessQuote } from "../../../packages/market/src/index.js";
import { ExecutionSafetyError, UncertainExecutionError } from "./errors.js";
import { enforceTransactionPolicy, type TransactionPolicy } from "./transaction-policy.js";
import type {
  ExecutionRepository,
  ExecutorClock,
  PumpUiAdapter,
  TermsAuthorization,
  TradeRequest,
  WalletAdapter,
} from "./types.js";
import { systemClock } from "./types.js";

export interface ExecuteTradeInput {
  request: TradeRequest;
  attemptId: string;
  termsAuthorization: TermsAuthorization | null;
  transactionPolicy: TransactionPolicy;
}

export class BrowserTradeExecutor {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly ui: PumpUiAdapter,
    private readonly wallet: WalletAdapter,
    private readonly clock: ExecutorClock = systemClock,
  ) {}

  async execute(input: ExecuteTradeInput): Promise<{ signature: string; messageDigest: string }> {
    const { request } = input;
    const attempt = await this.repository.getAttempt(request.intent.id, input.attemptId);
    if (!attempt || attempt.state !== "policy_checked") {
      throw new ExecutionSafetyError("Attempt is not ready for approval", "STATE_MISMATCH");
    }
    const authorization = input.termsAuthorization;
    if (
      !authorization
      || authorization.wallet !== request.intent.wallet
      || authorization.adapterFingerprint !== this.wallet.fingerprint
    ) {
      throw new ExecutionSafetyError("Current terms authorization is missing", "TERMS_AUTHORIZATION_REQUIRED");
    }
    if (!this.wallet.capabilities.inspectedSerializedTransactions || !this.wallet.capabilities.messageDigestBinding) {
      throw new ExecutionSafetyError("Wallet cannot bind inspected bytes to approval", "WALLET_CAPABILITY_MISSING");
    }

    const quoteDecision = assessQuote(request.quote, {
      mint: request.intent.mint,
      side: request.intent.side,
      allowedRoutes: new Set(["bonding_curve", "pumpswap"]),
      now: this.clock.now(),
    });
    if (!quoteDecision.allowed) throw new ExecutionSafetyError(quoteDecision.reasons.join(","), "QUOTE_REJECTED");
    await this.ui.inspectTrade(request);

    await this.repository.transition({
      intentId: request.intent.id,
      attemptId: input.attemptId,
      from: "policy_checked",
      to: "approval_pending",
      occurredAt: this.clock.now(),
    });

    try {
      const walletRequest = await this.wallet.captureTransactionRequest();
      const inspected = enforceTransactionPolicy(walletRequest.serializedTransactions, input.transactionPolicy);
      const aggregateDigest = createHash("sha256")
        .update(inspected.map((transaction) => transaction.digest).join(":"))
        .digest("hex");
      const approval = await this.wallet.approveBoundDigest(walletRequest.requestId, aggregateDigest);
      if (approval.messageDigest !== aggregateDigest || !approval.signature) {
        throw new ExecutionSafetyError("Wallet approval does not match inspected bytes", "DIGEST_BINDING_FAILED");
      }
      await this.repository.transition({
        intentId: request.intent.id,
        attemptId: input.attemptId,
        from: "approval_pending",
        to: "submitted",
        occurredAt: this.clock.now(),
        messageDigest: aggregateDigest,
        signature: approval.signature,
      });
      return { signature: approval.signature, messageDigest: aggregateDigest };
    } catch (error) {
      await this.repository.transition({
        intentId: request.intent.id,
        attemptId: input.attemptId,
        from: "approval_pending",
        to: "uncertain",
        occurredAt: this.clock.now(),
        reason: error instanceof Error ? error.message : "unknown approval failure",
      });
      await this.repository.haltWallet(request.intent.wallet, "Uncertain browser approval", this.clock.now());
      throw new UncertainExecutionError("Approval outcome is uncertain; wallet execution is halted");
    }
  }
}
