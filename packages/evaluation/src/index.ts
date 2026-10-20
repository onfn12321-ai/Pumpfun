export interface ClosedTrade {
  mint: string;
  openedAt: Date;
  closedAt: Date;
  netPnlLamports: bigint;
  capitalLamports: bigint;
  feesLamports: bigint;
  slippageLamports: bigint;
  failedAttempts: number;
}

export interface EvaluationMetrics {
  trades: number;
  netPnlLamports: bigint;
  grossProfitLamports: bigint;
  grossLossLamports: bigint;
  netExpectancyLamports: bigint;
  profitFactor: number | null;
  winRate: number;
  maximumDrawdownBps: number;
  totalCostsLamports: bigint;
  failedAttempts: number;
}

export function evaluateTrades(trades: readonly ClosedTrade[]): EvaluationMetrics {
  const ordered = [...trades].sort((left, right) => left.closedAt.getTime() - right.closedAt.getTime());
  let net = 0n;
  let grossProfit = 0n;
  let grossLoss = 0n;
  let costs = 0n;
  let failedAttempts = 0;
  let wins = 0;
  let equity = 0n;
  let peak = 0n;
  let maxDrawdownBps = 0;

  for (const trade of ordered) {
    if (trade.capitalLamports <= 0n) throw new Error("trade capital must be positive");
    net += trade.netPnlLamports;
    costs += trade.feesLamports + trade.slippageLamports;
    failedAttempts += trade.failedAttempts;
    if (trade.netPnlLamports > 0n) { grossProfit += trade.netPnlLamports; wins += 1; }
    if (trade.netPnlLamports < 0n) grossLoss += -trade.netPnlLamports;
    equity += trade.netPnlLamports;
    if (equity > peak) peak = equity;
    const denominator = trade.capitalLamports + peak;
    if (equity < peak && denominator > 0n) {
      const drawdown = Number(((peak - equity) * 10_000n) / denominator);
      maxDrawdownBps = Math.max(maxDrawdownBps, drawdown);
    }
  }

  return {
    trades: ordered.length,
    netPnlLamports: net,
    grossProfitLamports: grossProfit,
    grossLossLamports: grossLoss,
    netExpectancyLamports: ordered.length === 0 ? 0n : net / BigInt(ordered.length),
    profitFactor: grossLoss === 0n ? (grossProfit > 0n ? Number.POSITIVE_INFINITY : null) : Number(grossProfit) / Number(grossLoss),
    winRate: ordered.length === 0 ? 0 : wins / ordered.length,
    maximumDrawdownBps: maxDrawdownBps,
    totalCostsLamports: costs,
    failedAttempts,
  };
}

export interface GateAssessment {
  passed: boolean;
  reasons: string[];
}

export function assessHistoricalGate(metrics: EvaluationMetrics, outOfSampleDays: number, lowerConfidenceBoundLamports: bigint, doubledCostNetPnlLamports: bigint): GateAssessment {
  const reasons: string[] = [];
  if (outOfSampleDays < 30) reasons.push("OUT_OF_SAMPLE_DAYS_BELOW_30");
  if (metrics.trades < 200) reasons.push("CLOSED_TRADES_BELOW_200");
  if (metrics.netExpectancyLamports <= 0n || lowerConfidenceBoundLamports <= 0n) reasons.push("EXPECTANCY_NOT_POSITIVE");
  if (metrics.profitFactor === null || metrics.profitFactor < 1.2) reasons.push("PROFIT_FACTOR_BELOW_1_2");
  if (metrics.maximumDrawdownBps >= 1_000) reasons.push("DRAWDOWN_NOT_BELOW_10_PERCENT");
  if (doubledCostNetPnlLamports < 0n) reasons.push("DOUBLED_COST_RETURN_NEGATIVE");
  return { passed: reasons.length === 0, reasons };
}
