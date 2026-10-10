import type { Quote, TradeIntent, TradeSide } from "../../../packages/shared/src/index.js";

export type { Quote, TradeIntent, TradeSide };

export type ExecutionState =
  | "created"
  | "reserved"
  | "quoted"
  | "policy_checked"
  | "approval_pending"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "rejected"
  | "failed"
  | "expired"
  | "uncertain";

export interface ExecutionAttempt {
  id: string;
  intentId: string;
  attemptNumber: number;
  state: ExecutionState;
  messageDigest?: string;
  signature?: string;
  blockhash?: string;
  error?: string;
}

export interface TransitionRequest {
  intentId: string;
  attemptId: string;
  from: ExecutionState;
  to: ExecutionState;
  occurredAt: Date;
  reason?: string;
  messageDigest?: string;
  signature?: string;
  blockhash?: string;
}

/**
 * The executor only knows state through this interface. Implementations must make
 * transition() atomic and reject stale/from-state mismatches.
 */
export interface ExecutionRepository {
  getAttempt(intentId: string, attemptId: string): Promise<ExecutionAttempt | null>;
  transition(request: TransitionRequest): Promise<ExecutionAttempt>;
  haltWallet(wallet: string, reason: string, occurredAt: Date): Promise<void>;
}

export interface QuoteWithValidity extends Quote {
  /** Slot at which the route/reserves were independently checked. */
  reserveSnapshotSlot: bigint;
}

export interface TradeRequest {
  intent: TradeIntent;
  quote: QuoteWithValidity;
  expectedOrigin: string;
  slippageBps: number;
}

export interface UiTradeSnapshot {
  origin: string;
  wallet: string;
  mint: string;
  side: TradeSide;
  inputAmount: bigint;
  route: Quote["route"];
  minimumOutput: bigint;
  slippageBps: number;
}

export interface TermsAuthorization {
  recordId: string;
  authorizedAt: Date;
  adapterFingerprint: string;
  wallet: string;
}

export interface WalletCapabilities {
  /** The extension exposes the exact bytes before a signing action is taken. */
  inspectedSerializedTransactions: boolean;
  /** The adapter cryptographically/capability binds the inspected digest to approval. */
  messageDigestBinding: boolean;
}

export interface WalletTransactionRequest {
  requestId: string;
  serializedTransactions: Uint8Array[];
}

export interface WalletApproval {
  requestId: string;
  messageDigest: string;
  signature: string;
}

export interface WalletAdapter {
  readonly capabilities: WalletCapabilities;
  readonly fingerprint: string;
  captureTransactionRequest(): Promise<WalletTransactionRequest>;
  approveBoundDigest(requestId: string, messageDigest: string): Promise<WalletApproval>;
}

export interface PumpUiAdapter {
  inspectTrade(request: TradeRequest): Promise<UiTradeSnapshot>;
}

export interface ExecutorClock {
  now(): Date;
}

export const systemClock: ExecutorClock = { now: () => new Date() };
