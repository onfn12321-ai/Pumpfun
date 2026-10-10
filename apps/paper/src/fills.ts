import type { TradeSide } from "../../../packages/shared/src/index.js";

export interface PaperOrder {
  id: string;
  mint: string;
  side: TradeSide;
  inputAmount: bigint;
  submittedAt: Date;
  maxSlippageBps: number;
}

/** An executable observation, never a future candle close. Amounts are integer base units. */
export interface PaperQuote {
  mint: string;
  side: TradeSide;
  inputAmount: bigint;
  expectedOutput: bigint;
  feeAmount: bigint;
  priceImpactBps: number;
  observedAt: Date;
  sourceSlot: bigint;
  route: "bonding_curve" | "pumpswap";
}

export interface PaperFillConfig {
  buyLatencyMs: number;
  sellLatencyMs: number;
  networkFeeLamports: bigint;
  priorityFeeLamports: bigint;
  /** Additional adverse movement beyond the executable quote. */
  latencySlippageBps: number;
  maxQuoteAgeMs: number;
}

export interface PaperFill {
  orderId: string;
  status: "filled" | "rejected";
  reason?: string;
  filledAt: Date;
  outputAmount: bigint;
  feesLamports: bigint;
  modeledSlippageBps: number;
  quote?: PaperQuote;
}

const BPS = 10_000n;

function adverseOutput(output: bigint, bps: number): bigint {
  return output * BigInt(10_000 - bps) / BPS;
}

/**
 * Selects the most recent quote visible by the modeled execution instant.
 * It deliberately does not select a later quote, which would be look-ahead.
 */
export function executePaperOrder(
  order: PaperOrder,
  quotes: readonly PaperQuote[],
  config: PaperFillConfig,
): PaperFill {
  const latency = order.side === "buy" ? config.buyLatencyMs : config.sellLatencyMs;
  const filledAt = new Date(order.submittedAt.getTime() + latency);
  const eligible = quotes
    .filter((quote) => quote.mint === order.mint && quote.side === order.side && quote.inputAmount === order.inputAmount && quote.observedAt <= filledAt)
    .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime() || Number(right.sourceSlot - left.sourceSlot));
  const quote = eligible[0];
  if (quote === undefined) return rejected(order, filledAt, "no_quote_available_at_execution");
  if (filledAt.getTime() - quote.observedAt.getTime() > config.maxQuoteAgeMs) return rejected(order, filledAt, "stale_quote", quote);
  const modeledSlippageBps = quote.priceImpactBps + config.latencySlippageBps;
  if (modeledSlippageBps > order.maxSlippageBps) return rejected(order, filledAt, "slippage_limit", quote, modeledSlippageBps);
  if (modeledSlippageBps > 200 || config.latencySlippageBps < 0) return rejected(order, filledAt, "invalid_cost_model", quote, modeledSlippageBps);

  return {
    orderId: order.id,
    status: "filled",
    filledAt,
    outputAmount: adverseOutput(quote.expectedOutput, modeledSlippageBps),
    feesLamports: quote.feeAmount + config.networkFeeLamports + config.priorityFeeLamports,
    modeledSlippageBps,
    quote,
  };
}

function rejected(order: PaperOrder, filledAt: Date, reason: string, quote?: PaperQuote, modeledSlippageBps = 0): PaperFill {
  return {
    orderId: order.id,
    status: "rejected",
    reason,
    filledAt,
    outputAmount: 0n,
    feesLamports: 0n,
    modeledSlippageBps,
    ...(quote === undefined ? {} : { quote }),
  };
}
