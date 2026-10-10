export type AgentMode = "replay" | "paper" | "live";
export type TradeSide = "buy" | "sell";

export const intentStates = [
  "created",
  "reserved",
  "quoted",
  "policy_checked",
  "approval_pending",
  "submitted",
  "confirmed",
  "finalized",
  "rejected",
  "failed",
  "expired",
  "uncertain",
] as const;
export type IntentState = (typeof intentStates)[number];

export const attemptStates = [
  "created",
  "approval_pending",
  "submitted",
  "confirmed",
  "finalized",
  "failed",
  "expired",
  "uncertain",
] as const;
export type AttemptState = (typeof attemptStates)[number];

const allowedIntentTransitions: Readonly<Record<IntentState, readonly IntentState[]>> = {
  created: ["reserved", "rejected", "failed", "expired"],
  reserved: ["quoted", "rejected", "failed", "expired"],
  quoted: ["policy_checked", "reserved", "rejected", "failed", "expired"],
  policy_checked: ["approval_pending", "quoted", "rejected", "failed", "expired"],
  approval_pending: ["submitted", "uncertain", "rejected", "failed", "expired"],
  submitted: ["confirmed", "finalized", "failed", "expired", "uncertain"],
  confirmed: ["finalized", "failed", "uncertain"],
  finalized: [],
  rejected: [],
  failed: [],
  expired: [],
  uncertain: ["submitted", "confirmed", "finalized", "failed", "expired"],
};

const allowedAttemptTransitions: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  created: ["approval_pending", "failed", "expired"],
  approval_pending: ["submitted", "uncertain", "failed", "expired"],
  submitted: ["confirmed", "finalized", "failed", "expired", "uncertain"],
  confirmed: ["finalized", "failed", "uncertain"],
  finalized: [],
  failed: [],
  expired: [],
  uncertain: ["submitted", "confirmed", "finalized", "failed", "expired"],
};

export function canTransitionIntent(from: IntentState, to: IntentState): boolean {
  return allowedIntentTransitions[from].includes(to);
}

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  return allowedAttemptTransitions[from].includes(to);
}

export class InvalidStateTransitionError extends Error {
  constructor(kind: "intent" | "attempt", from: string, to: string) {
    super(`Invalid ${kind} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export interface IntentRecord {
  id: string;
  logicalKey: string;
  wallet: string;
  strategyVersion: string;
  mint: string;
  side: TradeSide;
  signalBucket: Date;
  amountBaseUnits: bigint;
  reservedSol: string;
  quote: Record<string, unknown> | null;
  configHash: string;
  state: IntentState;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttemptRecord {
  id: string;
  intentId: string;
  attemptNumber: number;
  messageHash: string | null;
  signature: string | null;
  blockhash: string | null;
  validity: Record<string, unknown> | null;
  state: AttemptState;
  error: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FillRecord {
  signature: string;
  instructionIndex: number;
  intentId: string | null;
  mint: string;
  tokenDelta: bigint;
  solDelta: string;
  feeBreakdown: Record<string, unknown>;
  commitment: "processed" | "confirmed" | "finalized";
  observedAt: Date;
}

export interface PositionRecord {
  wallet: string;
  mint: string;
  quantity: bigint;
  costBasisSol: string;
  peakExitValueSol: string;
  state: "open" | "closed" | "unresolved";
  updatedAt: Date;
}

export interface LedgerEntry {
  id: string;
  wallet: string;
  intentId: string | null;
  entryType: "fee" | "rent" | "cash_flow" | "realized_pnl" | "adjustment";
  amountSol: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

export interface RiskDayRecord {
  wallet: string;
  utcDate: string;
  openingEquitySol: string;
  externalFlowsSol: string;
  netPnlSol: string;
  halted: boolean;
  updatedAt: Date;
}

export interface ControlRecord {
  wallet: string;
  mode: AgentMode;
  entryHalt: boolean;
  executionHalt: boolean;
  reason: string | null;
  revision: number;
  liquidationRequestedAt: Date | null;
  updatedAt: Date;
}

export interface StrategyConfigRecord {
  configHash: string;
  parameters: Record<string, unknown>;
  strategyVersion: string;
  createdAt: Date;
}

export interface DecisionRecord {
  id: string;
  mint: string;
  signalBucket: Date;
  configHash: string;
  featureSnapshot: Record<string, unknown>;
  action: string;
  reasons: string[];
  createdAt: Date;
}

export interface MarketEventRecord {
  eventId: string;
  mint: string;
  slot: bigint;
  signature: string | null;
  instructionIndex: number | null;
  observedAt: Date;
  chainTime: Date | null;
  commitment: "processed" | "confirmed" | "finalized";
  payloadRef: string | null;
  decoderVersion: string;
}

export interface SnapshotRecord {
  id: string;
  mint: string;
  slot: bigint;
  reserves: Record<string, unknown>;
  holders: Record<string, unknown>;
  authorities: Record<string, unknown>;
  fees: Record<string, unknown>;
  capturedAt: Date;
}

export interface AuditEventRecord {
  id: string;
  wallet: string | null;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}
