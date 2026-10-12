export type Commitment = "processed" | "confirmed" | "finalized";
export type MarketEventSource = "browser" | "rpc" | "indexer" | "fixture";
export type MarketEventKind = "trade" | "reserve_snapshot" | "fee_snapshot" | "route_change";

/** A normalized observation. Timestamps retain when something happened and when it became usable. */
export interface CanonicalMarketEvent {
  eventId: string;
  kind: MarketEventKind;
  mint: string;
  source: MarketEventSource;
  slot: bigint;
  signature?: string;
  instructionIndex?: number;
  chainTime: Date;
  observedAt: Date;
  commitment: Commitment;
  rawPayloadRef: string;
  decoderVersion: string;
  trade?: CanonicalTrade;
  reserves?: ReserveState;
  fees?: FeeState;
}

export interface CanonicalTrade {
  side: "buy" | "sell";
  priceSol: number;
  volumeSol: number;
  buyer: string;
}

export interface ReserveState {
  quoteReserveLamports: bigint;
  baseReserve: bigint;
  route: "bonding_curve" | "migrating" | "pumpswap";
}

export interface FeeState {
  tradeFeeBps: number;
  feeRecipient: string;
}

export interface StreamGap {
  source: MarketEventSource;
  fromSlot: bigint;
  toSlot: bigint;
  detectedAt: Date;
  reason: "disconnect" | "backfill_failed" | "slot_regression";
}

export interface StreamHealth {
  source: MarketEventSource;
  highWatermarkSlot?: bigint;
  gaps: readonly StreamGap[];
  healthy: boolean;
}

export interface CaptureResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
  event?: CanonicalMarketEvent;
}
