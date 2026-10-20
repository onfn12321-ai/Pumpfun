import { randomUUID } from "node:crypto";
import {
  type AgentMode,
  type AttemptRecord,
  type AttemptState,
  type AuditEventRecord,
  canTransitionAttempt,
  canTransitionIntent,
  type ControlRecord,
  type DecisionRecord,
  type FillRecord,
  type IntentRecord,
  type IntentState,
  InvalidStateTransitionError,
  type LedgerEntry,
  type MarketEventRecord,
  type PositionRecord,
  type RiskDayRecord,
  type SnapshotRecord,
  type StrategyConfigRecord,
} from "./types.js";

export class DuplicateLogicalIntentError extends Error {
  constructor(logicalKey: string) {
    super(`An intent already exists for logical key ${logicalKey}`);
    this.name = "DuplicateLogicalIntentError";
  }
}

export class RevisionConflictError extends Error {
  constructor(resource: string) {
    super(`Revision conflict for ${resource}`);
    this.name = "RevisionConflictError";
  }
}

export interface CreateIntentInput {
  id?: string;
  logicalKey: string;
  wallet: string;
  strategyVersion: string;
  mint: string;
  side: IntentRecord["side"];
  signalBucket: Date;
  amountBaseUnits: bigint;
  reservedSol: string;
  configHash: string;
}

export interface CreateAttemptInput {
  id?: string;
  intentId: string;
  attemptNumber: number;
  messageHash?: string | null;
  signature?: string | null;
  blockhash?: string | null;
  validity?: Record<string, unknown> | null;
}

export interface PendingAttempt {
  intent: IntentRecord;
  attempt: AttemptRecord;
}

export interface DurableRepository {
  createIntent(input: CreateIntentInput): Promise<IntentRecord>;
  getIntent(id: string): Promise<IntentRecord | null>;
  transitionIntent(id: string, from: IntentState, to: IntentState, expectedVersion: number): Promise<IntentRecord>;
  createAttempt(input: CreateAttemptInput): Promise<AttemptRecord>;
  transitionAttempt(id: string, from: AttemptState, to: AttemptState, patch?: Partial<Pick<AttemptRecord, "signature" | "error" | "submittedAt" | "confirmedAt" | "finalizedAt">>): Promise<AttemptRecord>;
  listPendingAttempts(): Promise<PendingAttempt[]>;
  recordFill(fill: FillRecord): Promise<FillRecord>;
  upsertPosition(position: PositionRecord): Promise<PositionRecord>;
  appendLedger(entry: LedgerEntry): Promise<LedgerEntry>;
  upsertRiskDay(day: RiskDayRecord): Promise<RiskDayRecord>;
  putStrategyConfig(config: StrategyConfigRecord): Promise<StrategyConfigRecord>;
  recordDecision(decision: DecisionRecord): Promise<DecisionRecord>;
  recordMarketEvent(event: MarketEventRecord): Promise<MarketEventRecord>;
  recordSnapshot(snapshot: SnapshotRecord): Promise<SnapshotRecord>;
  appendAudit(event: AuditEventRecord): Promise<AuditEventRecord>;
  getOrCreateControl(wallet: string, mode: AgentMode): Promise<ControlRecord>;
  updateControl(wallet: string, expectedRevision: number, change: Pick<ControlRecord, "entryHalt" | "executionHalt" | "reason">): Promise<ControlRecord>;
  requestLiquidation(wallet: string, expectedRevision: number, reason: string): Promise<ControlRecord>;
  getStatus(wallet: string): Promise<{ control: ControlRecord; openPositions: PositionRecord[]; pendingAttempts: number }>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Deterministic implementation used by tests and local paper/replay wiring. Production
 * services use PostgresRepository; this class deliberately preserves the same constraints.
 */
export class InMemoryDurableRepository implements DurableRepository {
  private readonly intents = new Map<string, IntentRecord>();
  private readonly logicalKeys = new Map<string, string>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly attemptNumbers = new Set<string>();
  private readonly fills = new Map<string, FillRecord>();
  private readonly positions = new Map<string, PositionRecord>();
  private readonly controls = new Map<string, ControlRecord>();
  private readonly ledger: LedgerEntry[] = [];
  private readonly audits: AuditEventRecord[] = [];
  private readonly riskDays = new Map<string, RiskDayRecord>();
  private readonly configs = new Map<string, StrategyConfigRecord>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly events = new Map<string, MarketEventRecord>();
  private readonly snapshots = new Map<string, SnapshotRecord>();

  async createIntent(input: CreateIntentInput): Promise<IntentRecord> {
    if (this.logicalKeys.has(input.logicalKey)) throw new DuplicateLogicalIntentError(input.logicalKey);
    const now = new Date();
    const intent: IntentRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      quote: null,
      state: "created",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(intent.id, copy(intent));
    this.logicalKeys.set(intent.logicalKey, intent.id);
    return copy(intent);
  }

  async getIntent(id: string): Promise<IntentRecord | null> {
    const intent = this.intents.get(id);
    return intent ? copy(intent) : null;
  }

  async transitionIntent(id: string, from: IntentState, to: IntentState, expectedVersion: number): Promise<IntentRecord> {
    const current = this.intents.get(id);
    if (!current || current.state !== from || current.version !== expectedVersion) throw new RevisionConflictError(`intent ${id}`);
    if (!canTransitionIntent(from, to)) throw new InvalidStateTransitionError("intent", from, to);
    const next = { ...current, state: to, version: current.version + 1, updatedAt: new Date() };
    this.intents.set(id, next);
    return copy(next);
  }

  async createAttempt(input: CreateAttemptInput): Promise<AttemptRecord> {
    if (!this.intents.has(input.intentId)) throw new Error(`Unknown intent ${input.intentId}`);
    const key = `${input.intentId}:${input.attemptNumber}`;
    if (this.attemptNumbers.has(key)) throw new Error(`Attempt ${input.attemptNumber} already exists for intent ${input.intentId}`);
    if (input.signature && [...this.attempts.values()].some((attempt) => attempt.signature === input.signature)) {
      throw new Error(`Attempt signature already exists: ${input.signature}`);
    }
    const now = new Date();
    const attempt: AttemptRecord = {
      id: input.id ?? randomUUID(), intentId: input.intentId, attemptNumber: input.attemptNumber,
      messageHash: input.messageHash ?? null, signature: input.signature ?? null, blockhash: input.blockhash ?? null,
      validity: input.validity ?? null, state: "created", error: null, submittedAt: null, confirmedAt: null,
      finalizedAt: null, createdAt: now, updatedAt: now,
    };
    this.attempts.set(attempt.id, copy(attempt));
    this.attemptNumbers.add(key);
    return copy(attempt);
  }

  async transitionAttempt(id: string, from: AttemptState, to: AttemptState, patch: Partial<Pick<AttemptRecord, "signature" | "error" | "submittedAt" | "confirmedAt" | "finalizedAt">> = {}): Promise<AttemptRecord> {
    const current = this.attempts.get(id);
    if (!current || current.state !== from) throw new RevisionConflictError(`attempt ${id}`);
    if (!canTransitionAttempt(from, to)) throw new InvalidStateTransitionError("attempt", from, to);
    if (patch.signature && [...this.attempts.values()].some((attempt) => attempt.id !== id && attempt.signature === patch.signature)) throw new Error(`Attempt signature already exists: ${patch.signature}`);
    const next = { ...current, ...patch, state: to, updatedAt: new Date() };
    this.attempts.set(id, next);
    return copy(next);
  }

  async listPendingAttempts(): Promise<PendingAttempt[]> {
    const finalStates = new Set<AttemptState>(["finalized", "failed", "expired"]);
    return [...this.attempts.values()].flatMap((attempt) => {
      const intent = this.intents.get(attempt.intentId);
      return !finalStates.has(attempt.state) && intent ? [{ intent: copy(intent), attempt: copy(attempt) }] : [];
    });
  }

  async recordFill(fill: FillRecord): Promise<FillRecord> {
    const key = `${fill.signature}:${fill.instructionIndex}`;
    const prior = this.fills.get(key);
    if (prior) return copy(prior);
    this.fills.set(key, copy(fill));
    return copy(fill);
  }

  async upsertPosition(position: PositionRecord): Promise<PositionRecord> { this.positions.set(`${position.wallet}:${position.mint}`, copy(position)); return copy(position); }
  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> { this.ledger.push(copy(entry)); return copy(entry); }
  async upsertRiskDay(day: RiskDayRecord): Promise<RiskDayRecord> { this.riskDays.set(`${day.wallet}:${day.utcDate}`, copy(day)); return copy(day); }
  async putStrategyConfig(config: StrategyConfigRecord): Promise<StrategyConfigRecord> { this.configs.set(config.configHash, copy(config)); return copy(config); }
  async recordDecision(decision: DecisionRecord): Promise<DecisionRecord> { this.decisions.set(decision.id, copy(decision)); return copy(decision); }
  async recordMarketEvent(event: MarketEventRecord): Promise<MarketEventRecord> { this.events.set(event.eventId, copy(event)); return copy(event); }
  async recordSnapshot(snapshot: SnapshotRecord): Promise<SnapshotRecord> { this.snapshots.set(snapshot.id, copy(snapshot)); return copy(snapshot); }
  async appendAudit(event: AuditEventRecord): Promise<AuditEventRecord> { this.audits.push(copy(event)); return copy(event); }

  async getOrCreateControl(wallet: string, mode: AgentMode): Promise<ControlRecord> {
    const existing = this.controls.get(wallet);
    if (existing) return copy(existing);
    const control: ControlRecord = { wallet, mode, entryHalt: false, executionHalt: false, reason: null, revision: 0, liquidationRequestedAt: null, updatedAt: new Date() };
    this.controls.set(wallet, control);
    return copy(control);
  }

  async updateControl(wallet: string, expectedRevision: number, change: Pick<ControlRecord, "entryHalt" | "executionHalt" | "reason">): Promise<ControlRecord> {
    const control = this.controls.get(wallet);
    if (!control || control.revision !== expectedRevision) throw new RevisionConflictError(`control ${wallet}`);
    const next = { ...control, ...change, revision: control.revision + 1, updatedAt: new Date() };
    this.controls.set(wallet, next);
    return copy(next);
  }

  async requestLiquidation(wallet: string, expectedRevision: number, reason: string): Promise<ControlRecord> {
    const control = this.controls.get(wallet);
    if (!control || control.revision !== expectedRevision) throw new RevisionConflictError(`control ${wallet}`);
    const next = { ...control, entryHalt: true, reason, liquidationRequestedAt: new Date(), revision: control.revision + 1, updatedAt: new Date() };
    this.controls.set(wallet, next);
    return copy(next);
  }

  async getStatus(wallet: string): Promise<{ control: ControlRecord; openPositions: PositionRecord[]; pendingAttempts: number }> {
    const control = await this.getOrCreateControl(wallet, "paper");
    const openPositions = [...this.positions.values()].filter((position) => position.wallet === wallet && position.state !== "closed").map(copy);
    const pendingAttempts = (await this.listPendingAttempts()).filter(({ intent }) => intent.wallet === wallet).length;
    return { control, openPositions, pendingAttempts };
  }
}
