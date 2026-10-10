import { meetsCostHurdle } from "../../../packages/market/src/index.js";
import { assessEntryRisk } from "../../../packages/risk/src/index.js";
import { evaluateExit, evaluateMomentumEntry, rankMomentumCandidates, type EntryDecision } from "../../../packages/strategy/src/index.js";
import {
  completedBuckets,
  holderProfile,
  INITIAL_VIRTUAL_SOL,
  type MarketState,
  quoteBuy,
  quoteSell,
  type TokenState,
} from "./market.js";

export type AuthorityStatus = "ok" | "reject";

export interface PaperTraderConfig {
  name: string;
  startingBalanceSol: number;
  positionBps: number;
  maxExposureBps: number;
  dailyLossBps: number;
  feeReserveSol: number;
  tradeFeeBps: number;
  networkFeeSol: number;
  priorityFeeSol: number;
  latencyMs: number;
  latencySlippageBps: number;
  slippageBps: number;
  minRealSolReserves: number;
  maxImpactBps: number;
  maxHolderPct: number;
  maxTop10Pct: number;
  maxCreatorPct: number;
  cooldownMs: number;
  gapCooldownMs: number;
  migrationPenaltyBps: number;
  /** Rent deposit for the token account that a first buy creates. */
  tokenAccountRentSol: number;
  /** True when the sell closes the token account and returns the deposit. */
  rentRefundedOnExit: boolean;
}

export const BASE_CONFIG: Omit<PaperTraderConfig, "name" | "minRealSolReserves"> = {
  startingBalanceSol: 10,
  positionBps: 500,
  maxExposureBps: 4_000,
  dailyLossBps: 1_000,
  feeReserveSol: 0.05,
  tradeFeeBps: 125,
  networkFeeSol: 0.000005,
  priorityFeeSol: 0.0002,
  latencyMs: 1_500,
  latencySlippageBps: 50,
  slippageBps: 100,
  maxImpactBps: 200,
  maxHolderPct: 5,
  maxTop10Pct: 25,
  maxCreatorPct: 5,
  cooldownMs: 30 * 60_000,
  gapCooldownMs: 5 * 60_000,
  migrationPenaltyBps: 300,
  tokenAccountRentSol: 0.00207,
  rentRefundedOnExit: true,
};

interface PendingOrder {
  side: "buy" | "sell";
  mint: string;
  fillAt: number;
  sizeSol: number;
  tokens: number;
  quotedOutput: number;
  reasons: string[];
}

export interface OpenPosition {
  mint: string;
  symbol: string;
  openedAt: number;
  tokens: number;
  entryCostSol: number;
  entryPrice: number;
  peakValueSol: number;
  exiting: boolean;
}

export interface ClosedPaperTrade {
  trader: string;
  mint: string;
  symbol: string;
  openedAt: string;
  closedAt: string;
  holdSeconds: number;
  entryCostSol: number;
  exitProceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  exitReasons: string[];
  failedAttempts: number;
}

export interface TraderSnapshot {
  name: string;
  cashSol: number;
  equitySol: number;
  returnPct: number;
  openPositions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  failedTransactions: number;
  halted: boolean;
  feesPaidSol: number;
  rejectionCounts: Record<string, number>;
}

const LAMPORTS = 1_000_000_000;
const toLamports = (sol: number): bigint => BigInt(Math.max(0, Math.round(sol * LAMPORTS)));

export class PaperTrader {
  cashSol: number;
  readonly positions = new Map<string, OpenPosition>();
  readonly closed: ClosedPaperTrade[] = [];
  readonly equityCurve: Array<{ at: string; equitySol: number }> = [];
  readonly rejectionCounts: Record<string, number> = {};
  private readonly pending: PendingOrder[] = [];
  private readonly cooldownUntil = new Map<string, number>();
  private readonly failedAttemptsByMint = new Map<string, number>();
  private dayKey = "";
  private dayOpenEquity: number;
  private halted = false;
  failedTransactions = 0;
  feesPaidSol = 0;

  constructor(readonly config: PaperTraderConfig, private readonly market: MarketState) {
    this.cashSol = config.startingBalanceSol;
    this.dayOpenEquity = config.startingBalanceSol;
  }

  isActive(mint: string): boolean {
    return this.positions.has(mint) || this.pending.some((order) => order.mint === mint);
  }

  private txFee(): number {
    return this.config.networkFeeSol + this.config.priorityFeeSol;
  }

  private count(reason: string): void {
    this.rejectionCounts[reason] = (this.rejectionCounts[reason] ?? 0) + 1;
  }

  /** Net SOL from selling the whole position now, after fees and latency slippage. Excludes a refundable deposit. */
  liquidationValue(position: OpenPosition, token: TokenState | undefined): number {
    if (!token) return 0;
    const { solOut } = quoteSell(token.vSol, token.vTokens, position.tokens, this.config.tradeFeeBps);
    const penalty = token.migrated ? this.config.migrationPenaltyBps : 0;
    return Math.max(0, solOut * (1 - (this.config.latencySlippageBps + penalty) / 10_000) - this.txFee());
  }

  private rentRefund(): number {
    return this.config.rentRefundedOnExit ? this.config.tokenAccountRentSol : 0;
  }

  equity(): number {
    let value = this.cashSol;
    for (const position of this.positions.values()) {
      value += this.liquidationValue(position, this.market.tokens.get(position.mint)) + this.rentRefund();
    }
    return value;
  }

  /** Executes every pending order whose modeled fill time has passed, using state observed before that time. */
  advanceTo(time: number): void {
    for (let index = 0; index < this.pending.length;) {
      const order = this.pending[index]!;
      if (order.fillAt > time) {
        index += 1;
        continue;
      }
      this.pending.splice(index, 1);
      this.fill(order);
    }
  }

  private fill(order: PendingOrder): void {
    const token = this.market.tokens.get(order.mint);
    const fee = this.txFee();
    this.cashSol -= fee;
    this.feesPaidSol += fee;
    if (!token) {
      this.failedTransactions += 1;
      return;
    }
    if (order.side === "buy") {
      if (token.migrated) {
        this.failedTransactions += 1;
        this.count("FILL_FAILED_MIGRATED");
        this.cashSol += order.sizeSol; // release the reservation
        return;
      }
      const quote = quoteBuy(token.vSol, token.vTokens, order.sizeSol, this.config.tradeFeeBps);
      const tokensOut = quote.tokensOut * (1 - this.config.latencySlippageBps / 10_000);
      if (tokensOut < order.quotedOutput * (1 - this.config.slippageBps / 10_000)) {
        // Transaction-enforced minimum output fails. Only the network fee is lost.
        this.failedTransactions += 1;
        this.count("FILL_FAILED_SLIPPAGE");
        this.cashSol += order.sizeSol;
        return;
      }
      this.feesPaidSol += order.sizeSol * (this.config.tradeFeeBps / 10_000);
      this.cashSol -= this.config.tokenAccountRentSol;
      this.positions.set(order.mint, {
        mint: order.mint,
        symbol: token.symbol,
        openedAt: order.fillAt,
        tokens: tokensOut,
        entryCostSol: order.sizeSol + fee + (this.config.rentRefundedOnExit ? 0 : this.config.tokenAccountRentSol),
        entryPrice: order.sizeSol / tokensOut,
        peakValueSol: 0,
        exiting: false,
      });
      return;
    }

    const position = this.positions.get(order.mint);
    if (!position) return;
    const { solOut } = quoteSell(token.vSol, token.vTokens, position.tokens, this.config.tradeFeeBps);
    const penalty = token.migrated ? this.config.migrationPenaltyBps : 0;
    const proceeds = solOut * (1 - (this.config.latencySlippageBps + penalty) / 10_000);
    if (!token.migrated && proceeds < order.quotedOutput * (1 - this.config.slippageBps / 10_000)) {
      this.failedTransactions += 1;
      this.failedAttemptsByMint.set(order.mint, (this.failedAttemptsByMint.get(order.mint) ?? 0) + 1);
      this.count("EXIT_FAILED_SLIPPAGE");
      position.exiting = false; // re-evaluated on the next tick with a fresh quote
      return;
    }
    this.feesPaidSol += (solOut / (1 - this.config.tradeFeeBps / 10_000)) * (this.config.tradeFeeBps / 10_000);
    this.cashSol += proceeds + this.rentRefund();
    this.positions.delete(order.mint);
    this.cooldownUntil.set(order.mint, order.fillAt + this.config.cooldownMs);
    const exitNet = proceeds - fee;
    const pnl = exitNet - position.entryCostSol;
    this.closed.push({
      trader: this.config.name,
      mint: order.mint,
      symbol: position.symbol,
      openedAt: new Date(position.openedAt).toISOString(),
      closedAt: new Date(order.fillAt).toISOString(),
      holdSeconds: Math.round((order.fillAt - position.openedAt) / 1000),
      entryCostSol: position.entryCostSol,
      exitProceedsSol: exitNet,
      pnlSol: pnl,
      pnlPct: (pnl / position.entryCostSol) * 100,
      exitReasons: order.reasons,
      failedAttempts: this.failedAttemptsByMint.get(order.mint) ?? 0,
    });
    this.failedAttemptsByMint.delete(order.mint);
  }

  /**
   * Runs exits and entries at a five-second boundary. Returns mints that need an
   * on-chain authority check before entry can be considered.
   */
  tick(now: number, authorities: ReadonlyMap<string, AuthorityStatus>): string[] {
    this.advanceTo(now);
    this.rollDay(now);
    const equity = this.equity();
    if (equity - this.dayOpenEquity <= -(this.dayOpenEquity * this.config.dailyLossBps) / 10_000) {
      if (!this.halted) this.count("DAILY_LOSS_HALT");
      this.halted = true;
    }
    this.evaluateExits(now);
    if (now % 60_000 < 5_000) this.equityCurve.push({ at: new Date(now).toISOString(), equitySol: round(equity) });
    if (this.halted) return [];
    return this.evaluateEntries(now, equity, authorities);
  }

  private rollDay(now: number): void {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayOpenEquity = this.equity();
    }
  }

  private evaluateExits(now: number): void {
    for (const position of this.positions.values()) {
      if (position.exiting) continue;
      const token = this.market.tokens.get(position.mint);
      const value = this.liquidationValue(position, token);
      position.peakValueSol = Math.max(position.peakValueSol, value);
      const decision = evaluateExit({
        netExecutableValueLamports: toLamports(value),
        entryCostLamports: toLamports(position.entryCostSol),
        peakNetExecutableValueLamports: toLamports(position.peakValueSol),
        openedAt: new Date(position.openedAt),
        now: new Date(now),
      });
      const reasons: string[] = [...decision.reasons];
      if (token?.migrated) reasons.push("ROUTE_MIGRATED");
      if (this.halted) reasons.push("DAILY_LOSS_LIQUIDATION");
      if (reasons.length === 0) continue;
      position.exiting = true;
      const quote = token ? quoteSell(token.vSol, token.vTokens, position.tokens, this.config.tradeFeeBps).solOut : 0;
      this.pending.push({ side: "sell", mint: position.mint, fillAt: now + this.config.latencyMs, sizeSol: 0, tokens: position.tokens, quotedOutput: quote, reasons });
    }
  }

  private evaluateEntries(now: number, equity: number, authorities: ReadonlyMap<string, AuthorityStatus>): string[] {
    if (now - this.market.lastGapAt < this.config.gapCooldownMs) {
      this.count("STREAM_GAP_COOLDOWN");
      return [];
    }
    const needsAuthority: string[] = [];
    const candidates: Array<{ mint: string; decision: EntryDecision; token: TokenState }> = [];
    for (const token of this.market.tokens.values()) {
      if (token.migrated || this.isActive(token.mint)) continue;
      if ((this.cooldownUntil.get(token.mint) ?? 0) > now) continue;
      if (now - token.createdAt < 10 * 60_000) continue;
      // Cheap prefilter: at least 20 buys in the last five minutes are required anyway.
      const recentBuys = countRecentBuys(token, now - 5 * 60_000);
      if (recentBuys < 20) continue;
      const window = completedBuckets(token, now);
      const decision = evaluateMomentumEntry({
        mint: token.mint,
        tokenCreatedAt: new Date(token.createdAt),
        decisionAt: new Date(window.decisionAt),
        completedBuckets: window.buckets,
        distinctBuyers5m: window.distinctBuyers,
      });
      if (decision.action !== "enter") {
        for (const reason of decision.reasons) this.count(reason);
        continue;
      }
      const rejection = this.safetyRejection(token);
      if (rejection) {
        this.count(rejection);
        continue;
      }
      const authority = authorities.get(token.mint);
      if (authority === undefined) {
        needsAuthority.push(token.mint);
        this.count("AUTHORITY_CHECK_PENDING");
        continue;
      }
      if (authority === "reject") {
        this.count("MINT_AUTHORITY_REJECTED");
        continue;
      }
      candidates.push({ mint: token.mint, decision, token });
    }

    for (const candidate of rankMomentumCandidates(candidates)) {
      const token = candidate.token;
      const sizingEquity = Math.min(equity, this.dayOpenEquity);
      const sizeSol = (sizingEquity * this.config.positionBps) / 10_000;
      const buy = quoteBuy(token.vSol, token.vTokens, sizeSol, this.config.tradeFeeBps);
      const sell = quoteSell(token.vSol + sizeSol, token.vTokens - buy.tokensOut, buy.tokensOut, this.config.tradeFeeBps);
      if (buy.impactBps > this.config.maxImpactBps || sell.impactBps > this.config.maxImpactBps) {
        this.count("QUOTE_PRICE_IMPACT_TOO_HIGH");
        continue;
      }
      const lostRentSol = this.config.rentRefundedOnExit ? 0 : this.config.tokenAccountRentSol;
      const txFeeBps = Math.ceil(((this.txFee() * 2 + lostRentSol) / sizeSol) * 10_000);
      const hurdle = meetsCostHurdle({
        entryFeeBps: this.config.tradeFeeBps,
        exitFeeBps: this.config.tradeFeeBps,
        entryImpactBps: buy.impactBps,
        exitImpactBps: sell.impactBps,
        slippageAllowanceBps: this.config.slippageBps,
        priorityFeeBps: txFeeBps,
        latencyCostBps: this.config.latencySlippageBps * 2,
      });
      if (!hurdle.allowed) {
        this.count("COST_HURDLE_NOT_MET");
        continue;
      }
      const exposure = [...this.positions.values()].reduce((sum, position) => sum + position.entryCostSol, 0)
        + this.pending.filter((order) => order.side === "buy").reduce((sum, order) => sum + order.sizeSol, 0);
      const risk = assessEntryRisk(
        {
          maxPositionBps: this.config.positionBps,
          maxDailyLossBps: this.config.dailyLossBps,
          maxExposureBps: this.config.maxExposureBps,
          feeReserveLamports: toLamports(this.config.feeReserveSol),
        },
        {
          currentEquityLamports: toLamports(equity),
          openingEquityLamports: toLamports(this.dayOpenEquity),
          externalFlowsLamports: 0n,
          availableCashLamports: toLamports(this.cashSol),
          currentExposureLamports: toLamports(exposure),
          unresolvedExposureLamports: 0n,
          netPnlLamports: equity >= this.dayOpenEquity ? toLamports(equity - this.dayOpenEquity) : -toLamports(this.dayOpenEquity - equity),
          entryHalt: this.halted,
          executionHalt: false,
          hasUnpriceableAsset: false,
        },
        {
          principalLamports: toLamports(sizeSol) - 1n,
          worstCaseFeesLamports: toLamports(this.txFee() * 2 + this.config.tokenAccountRentSol),
          worstCaseSlippageLamports: toLamports((sizeSol * this.config.slippageBps) / 10_000),
        },
      );
      if (!risk.allowed) {
        for (const reason of risk.reasons) this.count(reason);
        continue;
      }
      this.cashSol -= sizeSol;
      this.count("ENTRY_SUBMITTED");
      this.pending.push({ side: "buy", mint: token.mint, fillAt: now + this.config.latencyMs, sizeSol, tokens: 0, quotedOutput: buy.tokensOut, reasons: ["MOMENTUM_ENTRY"] });
    }
    return needsAuthority;
  }

  private safetyRejection(token: TokenState): string | undefined {
    if (token.vSol - INITIAL_VIRTUAL_SOL < this.config.minRealSolReserves) return "INSUFFICIENT_EXECUTABLE_RESERVES";
    const holders = holderProfile(token);
    if (holders.maxHolderPct > this.config.maxHolderPct) return "HOLDER_ABOVE_5_PCT";
    if (holders.top10Pct > this.config.maxTop10Pct) return "TOP10_ABOVE_25_PCT";
    if (holders.creatorPct > this.config.maxCreatorPct) return "CREATOR_ABOVE_5_PCT";
    if (token.creatorBought > 0 && token.creatorSold / token.creatorBought > 0.5) return "CREATOR_DUMPED";
    return undefined;
  }

  snapshot(): TraderSnapshot {
    const equity = this.equity();
    return {
      name: this.config.name,
      cashSol: round(this.cashSol),
      equitySol: round(equity),
      returnPct: round(((equity - this.config.startingBalanceSol) / this.config.startingBalanceSol) * 100),
      openPositions: this.positions.size,
      closedTrades: this.closed.length,
      wins: this.closed.filter((trade) => trade.pnlSol > 0).length,
      losses: this.closed.filter((trade) => trade.pnlSol <= 0).length,
      failedTransactions: this.failedTransactions,
      halted: this.halted,
      feesPaidSol: round(this.feesPaidSol),
      rejectionCounts: { ...this.rejectionCounts },
    };
  }
}

function countRecentBuys(token: TokenState, since: number): number {
  let count = 0;
  for (let index = token.trades.length - 1; index >= 0; index -= 1) {
    const trade = token.trades[index]!;
    if (trade.at < since) break;
    if (trade.side === "buy") count += 1;
  }
  return count;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function defaultVariants(startingBalanceSol = BASE_CONFIG.startingBalanceSol): PaperTraderConfig[] {
  const base = { ...BASE_CONFIG, startingBalanceSol, feeReserveSol: Math.min(BASE_CONFIG.feeReserveSol, startingBalanceSol * 0.05) };
  return [
    { ...base, name: "approved-strict", minRealSolReserves: 100 },
    { ...base, name: "exploratory-20sol", minRealSolReserves: 20 },
    {
      ...base,
      name: "exploratory-20sol-2x-costs",
      minRealSolReserves: 20,
      latencyMs: BASE_CONFIG.latencyMs * 2,
      latencySlippageBps: BASE_CONFIG.latencySlippageBps * 2,
      priorityFeeSol: BASE_CONFIG.priorityFeeSol * 2,
      migrationPenaltyBps: BASE_CONFIG.migrationPenaltyBps * 2,
    },
    { ...base, name: "exploratory-20sol-no-refund", minRealSolReserves: 20, rentRefundedOnExit: false },
  ];
}
