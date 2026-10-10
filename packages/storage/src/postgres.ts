import {
  type AgentMode, type AttemptRecord, type AttemptState, type AuditEventRecord, canTransitionAttempt, canTransitionIntent,
  type ControlRecord, type DecisionRecord, type FillRecord, type IntentRecord, type IntentState, InvalidStateTransitionError,
  type LedgerEntry, type MarketEventRecord, type PositionRecord, type RiskDayRecord, type SnapshotRecord, type StrategyConfigRecord,
} from "./types.js";
import { type CreateAttemptInput, type CreateIntentInput, DuplicateLogicalIntentError, type DurableRepository, type PendingAttempt, RevisionConflictError } from "./repository.js";

/** Narrow pg-compatible surface to keep repository unit tests independent from a database. */
export interface SqlExecutor {
  query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

type Row = Record<string, unknown>;
const asDate = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const asBigInt = (value: unknown): bigint => BigInt(String(value));
const json = (value: unknown): Record<string, unknown> => typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : (value ?? {}) as Record<string, unknown>;
const nullableJson = (value: unknown): Record<string, unknown> | null => value === null || value === undefined ? null : json(value);
const nullableDate = (value: unknown): Date | null => value === null || value === undefined ? null : asDate(value);

function intent(row: Row): IntentRecord {
  return { id: String(row.id), logicalKey: String(row.logical_key), wallet: String(row.wallet), strategyVersion: String(row.strategy_version), mint: String(row.mint), side: String(row.side) as IntentRecord["side"], signalBucket: asDate(row.signal_bucket), amountBaseUnits: asBigInt(row.amount_base_units), reservedSol: String(row.reserved_sol), quote: nullableJson(row.quote_json), configHash: String(row.config_hash), state: String(row.state) as IntentState, version: Number(row.version), createdAt: asDate(row.created_at), updatedAt: asDate(row.updated_at) };
}
function attempt(row: Row): AttemptRecord {
  return { id: String(row.id), intentId: String(row.intent_id), attemptNumber: Number(row.attempt_number), messageHash: row.message_hash as string | null, signature: row.signature as string | null, blockhash: row.blockhash as string | null, validity: nullableJson(row.validity_json), state: String(row.state) as AttemptState, error: row.error as string | null, submittedAt: nullableDate(row.submitted_at), confirmedAt: nullableDate(row.confirmed_at), finalizedAt: nullableDate(row.finalized_at), createdAt: asDate(row.created_at), updatedAt: asDate(row.updated_at) };
}
function control(row: Row): ControlRecord {
  return { wallet: String(row.wallet), mode: String(row.mode) as AgentMode, entryHalt: Boolean(row.entry_halt), executionHalt: Boolean(row.execution_halt), reason: row.reason as string | null, revision: Number(row.revision), liquidationRequestedAt: nullableDate(row.liquidation_requested_at), updatedAt: asDate(row.updated_at) };
}

export class PostgresRepository implements DurableRepository {
  constructor(private readonly db: SqlExecutor) {}

  async createIntent(input: CreateIntentInput): Promise<IntentRecord> {
    const result = await this.db.query<Row>(`INSERT INTO intents (id, logical_key, wallet, strategy_version, mint, side, signal_bucket, amount_base_units, reserved_sol, config_hash)
      VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [input.id ?? null, input.logicalKey, input.wallet, input.strategyVersion, input.mint, input.side, input.signalBucket, input.amountBaseUnits.toString(), input.reservedSol, input.configHash]).catch((error: { code?: string }) => {
      if (error.code === "23505") throw new DuplicateLogicalIntentError(input.logicalKey);
      throw error;
    });
    return intent(result.rows[0]!);
  }
  async getIntent(id: string): Promise<IntentRecord | null> {
    const result = await this.db.query<Row>("SELECT * FROM intents WHERE id = $1", [id]);
    return result.rows[0] ? intent(result.rows[0]) : null;
  }
  async transitionIntent(id: string, from: IntentState, to: IntentState, expectedVersion: number): Promise<IntentRecord> {
    if (!canTransitionIntent(from, to)) throw new InvalidStateTransitionError("intent", from, to);
    const result = await this.db.query<Row>("UPDATE intents SET state = $1, version = version + 1, updated_at = now() WHERE id = $2 AND state = $3 AND version = $4 RETURNING *", [to, id, from, expectedVersion]);
    if (!result.rows[0]) throw new RevisionConflictError(`intent ${id}`);
    return intent(result.rows[0]);
  }
  async createAttempt(input: CreateAttemptInput): Promise<AttemptRecord> {
    const result = await this.db.query<Row>(`INSERT INTO attempts (id, intent_id, attempt_number, message_hash, signature, blockhash, validity_json)
      VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`, [input.id ?? null, input.intentId, input.attemptNumber, input.messageHash ?? null, input.signature ?? null, input.blockhash ?? null, JSON.stringify(input.validity ?? null)]);
    return attempt(result.rows[0]!);
  }
  async transitionAttempt(id: string, from: AttemptState, to: AttemptState, patch: Partial<Pick<AttemptRecord, "signature" | "error" | "submittedAt" | "confirmedAt" | "finalizedAt">> = {}): Promise<AttemptRecord> {
    if (!canTransitionAttempt(from, to)) throw new InvalidStateTransitionError("attempt", from, to);
    const result = await this.db.query<Row>(`UPDATE attempts SET state = $1, signature = COALESCE($2, signature), error = COALESCE($3, error),
      submitted_at = COALESCE($4, submitted_at), confirmed_at = COALESCE($5, confirmed_at), finalized_at = COALESCE($6, finalized_at), updated_at = now()
      WHERE id = $7 AND state = $8 RETURNING *`, [to, patch.signature ?? null, patch.error ?? null, patch.submittedAt ?? null, patch.confirmedAt ?? null, patch.finalizedAt ?? null, id, from]);
    if (!result.rows[0]) throw new RevisionConflictError(`attempt ${id}`);
    return attempt(result.rows[0]);
  }
  async listPendingAttempts(): Promise<PendingAttempt[]> {
    const result = await this.db.query<Row>(`SELECT a.id AS a_id, a.intent_id AS a_intent_id, a.attempt_number AS a_attempt_number, a.message_hash AS a_message_hash, a.signature AS a_signature, a.blockhash AS a_blockhash, a.validity_json AS a_validity_json, a.state AS a_state, a.error AS a_error, a.submitted_at AS a_submitted_at, a.confirmed_at AS a_confirmed_at, a.finalized_at AS a_finalized_at, a.created_at AS a_created_at, a.updated_at AS a_updated_at,
      i.* FROM attempts a JOIN intents i ON i.id = a.intent_id WHERE a.state NOT IN ('finalized', 'failed', 'expired')`);
    return result.rows.map((row) => ({ intent: intent(row), attempt: attempt({ id: row.a_id, intent_id: row.a_intent_id, attempt_number: row.a_attempt_number, message_hash: row.a_message_hash, signature: row.a_signature, blockhash: row.a_blockhash, validity_json: row.a_validity_json, state: row.a_state, error: row.a_error, submitted_at: row.a_submitted_at, confirmed_at: row.a_confirmed_at, finalized_at: row.a_finalized_at, created_at: row.a_created_at, updated_at: row.a_updated_at }) }));
  }
  async recordFill(fill: FillRecord): Promise<FillRecord> {
    const result = await this.db.query<Row>(`INSERT INTO fills (signature, instruction_index, intent_id, mint, token_delta, sol_delta, fee_breakdown, commitment, observed_at)
      VALUES ($1,$2,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT (signature, instruction_index) DO UPDATE SET commitment = EXCLUDED.commitment RETURNING *`, [fill.signature, fill.instructionIndex, fill.intentId, fill.mint, fill.tokenDelta.toString(), fill.solDelta, JSON.stringify(fill.feeBreakdown), fill.commitment, fill.observedAt]);
    const row = result.rows[0]!;
    return { signature: String(row.signature), instructionIndex: Number(row.instruction_index), intentId: row.intent_id as string | null, mint: String(row.mint), tokenDelta: asBigInt(row.token_delta), solDelta: String(row.sol_delta), feeBreakdown: json(row.fee_breakdown), commitment: String(row.commitment) as FillRecord["commitment"], observedAt: asDate(row.observed_at) };
  }
  async upsertPosition(position: PositionRecord): Promise<PositionRecord> {
    const result = await this.db.query<Row>(`INSERT INTO positions (wallet,mint,quantity,cost_basis_sol,peak_exit_value_sol,state,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (wallet,mint) DO UPDATE SET quantity=EXCLUDED.quantity,cost_basis_sol=EXCLUDED.cost_basis_sol,peak_exit_value_sol=EXCLUDED.peak_exit_value_sol,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at RETURNING *`, [position.wallet, position.mint, position.quantity.toString(), position.costBasisSol, position.peakExitValueSol, position.state, position.updatedAt]);
    const row = result.rows[0]!; return { wallet: String(row.wallet), mint: String(row.mint), quantity: asBigInt(row.quantity), costBasisSol: String(row.cost_basis_sol), peakExitValueSol: String(row.peak_exit_value_sol), state: String(row.state) as PositionRecord["state"], updatedAt: asDate(row.updated_at) };
  }
  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> { await this.db.query("INSERT INTO ledger (id,wallet,intent_id,entry_type,amount_sol,occurred_at,metadata) VALUES ($1,$2,$3::uuid,$4,$5,$6,$7::jsonb)", [entry.id, entry.wallet, entry.intentId, entry.entryType, entry.amountSol, entry.occurredAt, JSON.stringify(entry.metadata)]); return entry; }
  async upsertRiskDay(day: RiskDayRecord): Promise<RiskDayRecord> { await this.db.query(`INSERT INTO risk_days (wallet,utc_date,opening_equity_sol,external_flows_sol,net_pnl_sol,halted,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (wallet,utc_date) DO UPDATE SET opening_equity_sol=EXCLUDED.opening_equity_sol,external_flows_sol=EXCLUDED.external_flows_sol,net_pnl_sol=EXCLUDED.net_pnl_sol,halted=EXCLUDED.halted,updated_at=EXCLUDED.updated_at`, [day.wallet,day.utcDate,day.openingEquitySol,day.externalFlowsSol,day.netPnlSol,day.halted,day.updatedAt]); return day; }
  async putStrategyConfig(config: StrategyConfigRecord): Promise<StrategyConfigRecord> { await this.db.query("INSERT INTO strategy_configs (config_hash,parameters_json,strategy_version,created_at) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (config_hash) DO NOTHING", [config.configHash,JSON.stringify(config.parameters),config.strategyVersion,config.createdAt]); return config; }
  async recordDecision(decision: DecisionRecord): Promise<DecisionRecord> { await this.db.query("INSERT INTO decisions (id,mint,signal_bucket,config_hash,feature_snapshot,action,reasons,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)", [decision.id,decision.mint,decision.signalBucket,decision.configHash,JSON.stringify(decision.featureSnapshot),decision.action,JSON.stringify(decision.reasons),decision.createdAt]); return decision; }
  async recordMarketEvent(event: MarketEventRecord): Promise<MarketEventRecord> { await this.db.query("INSERT INTO market_events (event_id,mint,slot,signature,instruction_index,observed_at,chain_time,commitment,payload_ref,decoder_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING", [event.eventId,event.mint,event.slot.toString(),event.signature,event.instructionIndex,event.observedAt,event.chainTime,event.commitment,event.payloadRef,event.decoderVersion]); return event; }
  async recordSnapshot(snapshot: SnapshotRecord): Promise<SnapshotRecord> { await this.db.query("INSERT INTO snapshots (id,mint,slot,reserves,holders,authorities,fees,captured_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8)", [snapshot.id,snapshot.mint,snapshot.slot.toString(),JSON.stringify(snapshot.reserves),JSON.stringify(snapshot.holders),JSON.stringify(snapshot.authorities),JSON.stringify(snapshot.fees),snapshot.capturedAt]); return snapshot; }
  async appendAudit(event: AuditEventRecord): Promise<AuditEventRecord> { await this.db.query("INSERT INTO audit_events (id,wallet,event_type,actor,payload,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [event.id,event.wallet,event.eventType,event.actor,JSON.stringify(event.payload),event.createdAt]); return event; }
  async getOrCreateControl(wallet: string, mode: AgentMode): Promise<ControlRecord> { const result = await this.db.query<Row>("INSERT INTO controls (wallet,mode) VALUES ($1,$2) ON CONFLICT (wallet) DO UPDATE SET wallet=EXCLUDED.wallet RETURNING *", [wallet,mode]); return control(result.rows[0]!); }
  async updateControl(wallet: string, expectedRevision: number, change: Pick<ControlRecord, "entryHalt" | "executionHalt" | "reason">): Promise<ControlRecord> { const result = await this.db.query<Row>("UPDATE controls SET entry_halt=$1,execution_halt=$2,reason=$3,revision=revision+1,updated_at=now() WHERE wallet=$4 AND revision=$5 RETURNING *", [change.entryHalt,change.executionHalt,change.reason,wallet,expectedRevision]); if (!result.rows[0]) throw new RevisionConflictError(`control ${wallet}`); return control(result.rows[0]); }
  async requestLiquidation(wallet: string, expectedRevision: number, reason: string): Promise<ControlRecord> { const result = await this.db.query<Row>("UPDATE controls SET entry_halt=true,reason=$1,liquidation_requested_at=now(),revision=revision+1,updated_at=now() WHERE wallet=$2 AND revision=$3 RETURNING *", [reason,wallet,expectedRevision]); if (!result.rows[0]) throw new RevisionConflictError(`control ${wallet}`); return control(result.rows[0]); }
  async getStatus(wallet: string): Promise<{ control: ControlRecord; openPositions: PositionRecord[]; pendingAttempts: number }> { const current = await this.db.query<Row>("SELECT * FROM controls WHERE wallet=$1",[wallet]); if (!current.rows[0]) throw new Error(`Control state missing for ${wallet}`); const positions = await this.db.query<Row>("SELECT * FROM positions WHERE wallet=$1 AND state <> 'closed'",[wallet]); const attempts = await this.db.query<Row>("SELECT count(*) AS count FROM attempts a JOIN intents i ON i.id=a.intent_id WHERE i.wallet=$1 AND a.state NOT IN ('finalized','failed','expired')",[wallet]); return { control: control(current.rows[0]), openPositions: positions.rows.map((row) => ({ wallet:String(row.wallet),mint:String(row.mint),quantity:asBigInt(row.quantity),costBasisSol:String(row.cost_basis_sol),peakExitValueSol:String(row.peak_exit_value_sol),state:String(row.state) as PositionRecord["state"],updatedAt:asDate(row.updated_at) })), pendingAttempts:Number(attempts.rows[0]?.count ?? 0) }; }
}
