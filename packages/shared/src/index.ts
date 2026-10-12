export type AgentMode = "replay" | "paper" | "live";

export type TradeSide = "buy" | "sell";

export interface MarketBucket {
  mint: string;
  startedAt: Date;
  closedAt: Date;
  openPriceSol: number;
  closePriceSol: number;
  highPriceSol: number;
  lowPriceSol: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  distinctBuyers: number;
}

export interface TradeIntent {
  id: string;
  logicalKey: string;
  wallet: string;
  mint: string;
  side: TradeSide;
  amountLamports: bigint;
  signalBucket: Date;
  configHash: string;
}

export interface Quote {
  mint: string;
  side: TradeSide;
  inputAmount: bigint;
  expectedOutput: bigint;
  minimumOutput: bigint;
  quotedAt: Date;
  sourceSlot: bigint;
  route: "bonding_curve" | "pumpswap";
  priceImpactBps: number;
  feeLamports: bigint;
}

export interface Decision<TAction extends string = string> {
  action: TAction;
  reasons: string[];
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
