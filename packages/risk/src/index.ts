export const HARD_MAX_POSITION_BPS = 500;
export const HARD_MAX_DAILY_LOSS_BPS = 1_000;
export const HARD_MAX_EXPOSURE_BPS = 4_000;

export type RiskReason =
  | "ENTRY_HALTED"
  | "EXECUTION_HALTED"
  | "DAILY_LOSS_LIMIT"
  | "POSITION_LIMIT"
  | "EXPOSURE_LIMIT"
  | "INSUFFICIENT_CASH"
  | "INSUFFICIENT_FEE_RESERVE"
  | "UNPRICEABLE_ASSET"
  | "INVALID_CONFIGURATION";

export interface RiskLimits {
  maxPositionBps: number;
  maxDailyLossBps: number;
  maxExposureBps: number;
  feeReserveLamports: bigint;
}

export interface RiskState {
  currentEquityLamports: bigint;
  openingEquityLamports: bigint;
  externalFlowsLamports: bigint;
  availableCashLamports: bigint;
  currentExposureLamports: bigint;
  unresolvedExposureLamports: bigint;
  netPnlLamports: bigint;
  entryHalt: boolean;
  executionHalt: boolean;
  hasUnpriceableAsset: boolean;
}

export interface PositionRequest {
  principalLamports: bigint;
  worstCaseFeesLamports: bigint;
  worstCaseSlippageLamports: bigint;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: RiskReason[];
  reservedLamports: bigint;
  sizingEquityLamports: bigint;
}

function validBps(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

export function validateRiskLimits(limits: RiskLimits): void {
  if (
    !validBps(limits.maxPositionBps, HARD_MAX_POSITION_BPS)
    || !validBps(limits.maxDailyLossBps, HARD_MAX_DAILY_LOSS_BPS)
    || !validBps(limits.maxExposureBps, HARD_MAX_EXPOSURE_BPS)
    || limits.feeReserveLamports < 0n
  ) {
    throw new Error("risk limits exceed approved hard ceilings");
  }
}

export function bpsOf(value: bigint, bps: number): bigint {
  if (value < 0n || !Number.isInteger(bps) || bps < 0) throw new Error("invalid bps calculation");
  return (value * BigInt(bps)) / 10_000n;
}

export function assessEntryRisk(limits: RiskLimits, state: RiskState, request: PositionRequest): RiskDecision {
  validateRiskLimits(limits);
  if (request.principalLamports <= 0n || request.worstCaseFeesLamports < 0n || request.worstCaseSlippageLamports < 0n) {
    throw new Error("invalid position request");
  }

  const reasons: RiskReason[] = [];
  const cashFlowAdjustedOpening = state.openingEquityLamports + state.externalFlowsLamports;
  const sizingEquity = state.currentEquityLamports < cashFlowAdjustedOpening
    ? state.currentEquityLamports
    : cashFlowAdjustedOpening;
  const reserved = request.principalLamports + request.worstCaseFeesLamports + request.worstCaseSlippageLamports;
  const existingExposure = state.currentExposureLamports + state.unresolvedExposureLamports;

  if (state.entryHalt) reasons.push("ENTRY_HALTED");
  if (state.executionHalt) reasons.push("EXECUTION_HALTED");
  if (state.hasUnpriceableAsset) reasons.push("UNPRICEABLE_ASSET");
  if (state.netPnlLamports < -bpsOf(cashFlowAdjustedOpening, limits.maxDailyLossBps)) reasons.push("DAILY_LOSS_LIMIT");
  if (request.principalLamports > bpsOf(sizingEquity, limits.maxPositionBps)) reasons.push("POSITION_LIMIT");
  if (existingExposure + request.principalLamports > bpsOf(sizingEquity, limits.maxExposureBps)) reasons.push("EXPOSURE_LIMIT");
  if (reserved > state.availableCashLamports) reasons.push("INSUFFICIENT_CASH");
  if (state.availableCashLamports - reserved < limits.feeReserveLamports) reasons.push("INSUFFICIENT_FEE_RESERVE");

  return { allowed: reasons.length === 0, reasons, reservedLamports: reserved, sizingEquityLamports: sizingEquity };
}

export function mustHaltForDailyLoss(limits: RiskLimits, openingEquityLamports: bigint, externalFlowsLamports: bigint, netPnlLamports: bigint): boolean {
  validateRiskLimits(limits);
  return netPnlLamports <= -bpsOf(openingEquityLamports + externalFlowsLamports, limits.maxDailyLossBps);
}
