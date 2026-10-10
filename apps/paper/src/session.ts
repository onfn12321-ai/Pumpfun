import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateTrades } from "../../../packages/evaluation/src/index.js";
import { MarketState } from "./market.js";
import type { RecordedMessage } from "./stream.js";
import { type AuthorityStatus, PaperTrader, type PaperTraderConfig } from "./trader.js";

/** Runs several paper portfolios against one shared market state. */
export class PaperSession {
  readonly market = new MarketState();
  readonly traders: PaperTrader[];
  startedAt: number | undefined;
  lastTickAt: number | undefined;

  constructor(configs: readonly PaperTraderConfig[]) {
    this.traders = configs.map((config) => new PaperTrader(config, this.market));
  }

  ingest(message: RecordedMessage): void {
    this.startedAt ??= message.observedAt;
    for (const trader of this.traders) trader.advanceTo(message.observedAt);
    this.market.apply(message.observedAt, message.data);
  }

  tick(now: number, authorities: ReadonlyMap<string, AuthorityStatus>): string[] {
    this.lastTickAt = now;
    const needed = new Set<string>();
    for (const trader of this.traders) for (const mint of trader.tick(now, authorities)) needed.add(mint);
    if (now % 60_000 < 5_000) {
      this.market.prune(now, (mint) => this.traders.some((trader) => trader.isActive(mint)));
    }
    return [...needed];
  }

  summary(): Record<string, unknown> {
    const durationMinutes = this.startedAt !== undefined && this.lastTickAt !== undefined
      ? Math.round((this.lastTickAt - this.startedAt) / 60_000)
      : 0;
    return {
      generatedAt: new Date().toISOString(),
      dataStartedAt: this.startedAt === undefined ? null : new Date(this.startedAt).toISOString(),
      dataEndedAt: this.lastTickAt === undefined ? null : new Date(this.lastTickAt).toISOString(),
      durationMinutes,
      messages: this.market.messages,
      trackedTokens: this.market.tokens.size,
      invalidCurveTokens: this.market.invalidCurves,
      traders: this.traders.map((trader) => {
        const metrics = evaluateTrades(trader.closed.map((trade) => ({
          mint: trade.mint,
          openedAt: new Date(trade.openedAt),
          closedAt: new Date(trade.closedAt),
          netPnlLamports: BigInt(Math.round(trade.pnlSol * 1e9)),
          capitalLamports: BigInt(Math.round(trade.entryCostSol * 1e9)),
          feesLamports: 0n,
          slippageLamports: 0n,
          failedAttempts: trade.failedAttempts,
        })));
        return {
          ...trader.snapshot(),
          config: trader.config,
          metrics: {
            trades: metrics.trades,
            netPnlSol: Number(metrics.netPnlLamports) / 1e9,
            netExpectancySol: Number(metrics.netExpectancyLamports) / 1e9,
            profitFactor: metrics.profitFactor,
            winRate: metrics.winRate,
          },
          openPositionDetails: [...trader.positions.values()].map((position) => ({
            mint: position.mint,
            symbol: position.symbol,
            openedAt: new Date(position.openedAt).toISOString(),
            entryCostSol: position.entryCostSol,
            currentValueSol: trader.liquidationValue(position, this.market.tokens.get(position.mint)),
          })),
          equityCurve: trader.equityCurve,
        };
      }),
    };
  }

  writeReport(directory: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "summary.json"), JSON.stringify(this.summary(), null, 2));
    const trades = this.traders.flatMap((trader) => trader.closed);
    const header = "trader,mint,symbol,openedAt,closedAt,holdSeconds,entryCostSol,exitProceedsSol,pnlSol,pnlPct,exitReasons,failedAttempts";
    const rows = trades.map((trade) => [
      trade.trader, trade.mint, JSON.stringify(trade.symbol), trade.openedAt, trade.closedAt, trade.holdSeconds,
      trade.entryCostSol.toFixed(6), trade.exitProceedsSol.toFixed(6), trade.pnlSol.toFixed(6), trade.pnlPct.toFixed(2),
      trade.exitReasons.join("|"), trade.failedAttempts,
    ].join(","));
    writeFileSync(join(directory, "trades.csv"), `${[header, ...rows].join("\n")}\n`);
  }
}
