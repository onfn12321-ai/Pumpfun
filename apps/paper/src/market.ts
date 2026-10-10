import type { MarketBucket } from "../../../packages/shared/src/index.js";
import type { RawPumpMessage } from "./stream.js";

export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
export const INITIAL_VIRTUAL_SOL = 30;
export const INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
export const BUCKET_MS = 5_000;
export const HISTORY_BUCKETS = 60;

export interface CurveTrade {
  at: number;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  trader: string;
  vSol: number;
  vTokens: number;
}

export interface TokenState {
  mint: string;
  symbol: string;
  creator: string;
  createdAt: number;
  vSol: number;
  vTokens: number;
  trades: CurveTrade[];
  balances: Map<string, number>;
  creatorBought: number;
  creatorSold: number;
  migrated: boolean;
  lastEventAt: number;
}

export function priceOf(vSol: number, vTokens: number): number {
  return vSol / vTokens;
}

/** Shared, deterministic state built only from observed messages. */
export class MarketState {
  readonly tokens = new Map<string, TokenState>();
  lastGapAt = Number.NEGATIVE_INFINITY;
  messages = 0;

  apply(observedAt: number, data: RawPumpMessage): TokenState | undefined {
    this.messages += 1;
    if (data.txType === "stream_gap") {
      this.lastGapAt = observedAt;
      return undefined;
    }
    const mint = data.mint;
    if (!mint) return undefined;

    if (data.txType === "create") {
      if (this.tokens.has(mint) || data.pool !== "pump") return undefined;
      const initialBuy = Number(data.initialBuy ?? 0);
      const creator = String(data.traderPublicKey ?? "");
      const token: TokenState = {
        mint,
        symbol: String(data.symbol ?? ""),
        creator,
        createdAt: observedAt,
        vSol: Number(data.vSolInBondingCurve ?? INITIAL_VIRTUAL_SOL),
        vTokens: Number(data.vTokensInBondingCurve ?? INITIAL_VIRTUAL_TOKENS),
        trades: [],
        balances: new Map(initialBuy > 0 ? [[creator, initialBuy]] : []),
        creatorBought: initialBuy,
        creatorSold: 0,
        migrated: false,
        lastEventAt: observedAt,
      };
      if (initialBuy > 0) {
        token.trades.push({ at: observedAt, side: "buy", sol: Number(data.solAmount ?? 0), tokens: initialBuy, trader: creator, vSol: token.vSol, vTokens: token.vTokens });
      }
      this.tokens.set(mint, token);
      return token;
    }

    const token = this.tokens.get(mint);
    if (!token) return undefined;

    if (data.txType === "complete" || (data.pool !== undefined && data.pool !== "pump")) {
      token.migrated = true;
      token.lastEventAt = observedAt;
      return token;
    }

    if (data.txType !== "buy" && data.txType !== "sell") return undefined;
    const vSol = Number(data.vSolInBondingCurve);
    const vTokens = Number(data.vTokensInBondingCurve);
    const sol = Number(data.solAmount);
    const tokens = Number(data.tokenAmount);
    if (!(vSol > 0) || !(vTokens > 0) || !(sol > 0) || !(tokens > 0)) return undefined;
    const trader = String(data.traderPublicKey ?? "");
    token.vSol = vSol;
    token.vTokens = vTokens;
    token.lastEventAt = observedAt;
    token.trades.push({ at: observedAt, side: data.txType, sol, tokens, trader, vSol, vTokens });
    if (typeof data.newTokenBalance === "number") token.balances.set(trader, data.newTokenBalance);
    else {
      // Chain events carry the trade size, not the balance. Off-curve transfers are not seen.
      const balance = (token.balances.get(trader) ?? 0) + (data.txType === "buy" ? tokens : -tokens);
      token.balances.set(trader, Math.max(0, balance));
    }
    if (trader === token.creator) {
      if (data.txType === "buy") token.creatorBought += tokens;
      else token.creatorSold += tokens;
    }
    // The bonding curve graduates near 85 real SOL. Treat it as migrating.
    if (vSol - INITIAL_VIRTUAL_SOL >= 84 || data.realTokensInBondingCurve === 0) token.migrated = true;
    return token;
  }

  /** Removes stale tokens that no trader can still act on. */
  prune(now: number, keep: (mint: string) => boolean, maxAgeMs = 2 * 60 * 60_000): void {
    for (const [mint, token] of this.tokens) {
      if (!keep(mint) && now - token.createdAt > maxAgeMs) this.tokens.delete(mint);
    }
  }
}

function firstIndexAtOrAfter(trades: readonly CurveTrade[], time: number): number {
  let low = 0;
  let high = trades.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (trades[middle]!.at < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Builds the latest five minutes of completed five-second buckets. A bucket
 * without trades carries the prior price forward with zero volume.
 */
export function completedBuckets(token: TokenState, now: number): { buckets: MarketBucket[]; distinctBuyers: number; decisionAt: number } {
  const decisionAt = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const windowStart = decisionAt - HISTORY_BUCKETS * BUCKET_MS;
  const trades = token.trades;
  let index = firstIndexAtOrAfter(trades, windowStart);
  let previousPrice = index > 0
    ? priceOf(trades[index - 1]!.vSol, trades[index - 1]!.vTokens)
    : priceOf(INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS);
  const buyers = new Set<string>();
  const buckets: MarketBucket[] = [];
  for (let bucket = 0; bucket < HISTORY_BUCKETS; bucket += 1) {
    const start = windowStart + bucket * BUCKET_MS;
    const end = start + BUCKET_MS;
    const open = previousPrice;
    let high = open;
    let low = open;
    let close = open;
    let buyVolume = 0;
    let sellVolume = 0;
    let bucketBuyers = 0;
    while (index < trades.length && trades[index]!.at < end) {
      const trade = trades[index]!;
      close = priceOf(trade.vSol, trade.vTokens);
      high = Math.max(high, close);
      low = Math.min(low, close);
      if (trade.side === "buy") {
        buyVolume += trade.sol;
        if (!buyers.has(trade.trader)) bucketBuyers += 1;
        buyers.add(trade.trader);
      } else sellVolume += trade.sol;
      index += 1;
    }
    previousPrice = close;
    buckets.push({
      mint: token.mint,
      startedAt: new Date(start),
      closedAt: new Date(end),
      openPriceSol: open,
      closePriceSol: close,
      highPriceSol: high,
      lowPriceSol: low,
      buyVolumeSol: buyVolume,
      sellVolumeSol: sellVolume,
      distinctBuyers: bucketBuyers,
    });
  }
  return { buckets, distinctBuyers: buyers.size, decisionAt };
}

export interface HolderProfile {
  maxHolderPct: number;
  top10Pct: number;
  creatorPct: number;
}

export function holderProfile(token: TokenState): HolderProfile {
  const balances = [...token.balances.values()].filter((value) => value > 0).sort((left, right) => right - left);
  const top10 = balances.slice(0, 10).reduce((sum, value) => sum + value, 0);
  return {
    maxHolderPct: ((balances[0] ?? 0) / TOTAL_SUPPLY_TOKENS) * 100,
    top10Pct: (top10 / TOTAL_SUPPLY_TOKENS) * 100,
    creatorPct: ((token.balances.get(token.creator) ?? 0) / TOTAL_SUPPLY_TOKENS) * 100,
  };
}

/** Constant-product buy on virtual reserves with the input-side trading fee. */
export function quoteBuy(vSol: number, vTokens: number, solIn: number, feeBps: number): { tokensOut: number; impactBps: number } {
  const effective = solIn * (1 - feeBps / 10_000);
  const tokensOut = vTokens - (vSol * vTokens) / (vSol + effective);
  return { tokensOut, impactBps: Math.ceil((effective / (vSol + effective)) * 10_000) };
}

/** Constant-product sell on virtual reserves with the output-side trading fee. */
export function quoteSell(vSol: number, vTokens: number, tokensIn: number, feeBps: number): { solOut: number; impactBps: number } {
  const gross = vSol - (vSol * vTokens) / (vTokens + tokensIn);
  return { solOut: gross * (1 - feeBps / 10_000), impactBps: Math.ceil((tokensIn / (vTokens + tokensIn)) * 10_000) };
}
