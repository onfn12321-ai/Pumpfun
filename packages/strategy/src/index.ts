import type { MarketBucket } from "../../shared/src/index.js";

export const FIVE_SECOND_BUCKET_MS = 5_000;
export const MINIMUM_TOKEN_AGE_MS = 10 * 60_000;
export const REQUIRED_HISTORY_BUCKETS = 60;

export type EntryReason =
  | "TOKEN_TOO_NEW"
  | "INCOMPLETE_MARKET_HISTORY"
  | "INVALID_BUCKET_PRICE"
  | "RETURN_60S_OUT_OF_RANGE"
  | "RETURN_5M_OUT_OF_RANGE"
  | "VOLUME_ACCELERATION_TOO_LOW"
  | "INSUFFICIENT_DISTINCT_BUYERS"
  | "BUY_VOLUME_SHARE_TOO_LOW"
  | "SINGLE_BUCKET_PUMP";

export interface EntryDecision {
  action: "enter" | "no_trade";
  reasons: EntryReason[];
  features?: MomentumFeatures;
}

export interface MomentumFeatures {
  return60sBps: number;
  return5mBps: number;
  lastMinuteVolumeLamports: number;
  precedingFourMinuteMeanVolumeLamports: number;
  volumeRatio: number;
  buyVolumeShareBps: number;
  distinctBuyers5m: number;
  largestFiveSecondReturnBps: number;
}

export interface MomentumInput {
  mint: string;
  tokenCreatedAt: Date;
  decisionAt: Date;
  /** Exactly the latest five minutes of completed five-second buckets. */
  completedBuckets: readonly MarketBucket[];
  /** Deduplicated from buyer addresses, not a sum of bucket counts. */
  distinctBuyers5m: number;
}

function returnBps(start: number, end: number): number | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return undefined;
  return Math.round(((end - start) / start) * 10_000);
}

function hasCompleteHistory(buckets: readonly MarketBucket[], decisionAt: Date): boolean {
  if (buckets.length !== REQUIRED_HISTORY_BUCKETS) return false;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (!bucket || bucket.closedAt.getTime() - bucket.startedAt.getTime() !== FIVE_SECOND_BUCKET_MS) return false;
    if (bucket.closedAt.getTime() > decisionAt.getTime()) return false;
    if (index > 0 && bucket.startedAt.getTime() !== buckets[index - 1]!.closedAt.getTime()) return false;
  }
  return true;
}

/** Builds reproducible features using completed buckets only. */
export function calculateMomentumFeatures(input: MomentumInput): MomentumFeatures | undefined {
  const buckets = input.completedBuckets;
  if (!hasCompleteHistory(buckets, input.decisionAt)) return undefined;
  const lastMinuteStartIndex = REQUIRED_HISTORY_BUCKETS - (60_000 / FIVE_SECOND_BUCKET_MS);
  const lastIndex = REQUIRED_HISTORY_BUCKETS - 1;
  const first = buckets[0]!;
  const firstLastMinute = buckets[lastMinuteStartIndex]!;
  const last = buckets[lastIndex]!;
  const return60sBps = returnBps(firstLastMinute.openPriceSol, last.closePriceSol);
  const return5mBps = returnBps(first.openPriceSol, last.closePriceSol);
  if (return60sBps === undefined || return5mBps === undefined) return undefined;

  let precedingVolume = 0;
  let lastMinuteVolume = 0;
  let buyVolume = 0;
  let totalVolume = 0;
  let largestFiveSecondReturnBps = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]!;
    const volume = bucket.buyVolumeSol + bucket.sellVolumeSol;
    if (!Number.isFinite(volume) || volume < 0) return undefined;
    if (index < lastMinuteStartIndex) precedingVolume += volume;
    else lastMinuteVolume += volume;
    buyVolume += bucket.buyVolumeSol;
    totalVolume += volume;
    const change = returnBps(bucket.openPriceSol, bucket.closePriceSol);
    if (change === undefined) return undefined;
    largestFiveSecondReturnBps = Math.max(largestFiveSecondReturnBps, change);
  }
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return undefined;
  const precedingMean = precedingVolume / 4;
  return {
    return60sBps,
    return5mBps,
    lastMinuteVolumeLamports: lastMinuteVolume,
    precedingFourMinuteMeanVolumeLamports: precedingMean,
    volumeRatio: precedingMean === 0 ? Number.POSITIVE_INFINITY : lastMinuteVolume / precedingMean,
    buyVolumeShareBps: Math.floor((buyVolume / totalVolume) * 10_000),
    distinctBuyers5m: input.distinctBuyers5m,
    largestFiveSecondReturnBps,
  };
}

export function evaluateMomentumEntry(input: MomentumInput): EntryDecision {
  const reasons: EntryReason[] = [];
  if (input.decisionAt.getTime() - input.tokenCreatedAt.getTime() < MINIMUM_TOKEN_AGE_MS) reasons.push("TOKEN_TOO_NEW");
  const features = calculateMomentumFeatures(input);
  if (!features) {
    reasons.push("INCOMPLETE_MARKET_HISTORY");
    return { action: "no_trade", reasons };
  }
  if (features.return60sBps < 300 || features.return60sBps > 1_500) reasons.push("RETURN_60S_OUT_OF_RANGE");
  if (features.return5mBps < 800 || features.return5mBps > 4_000) reasons.push("RETURN_5M_OUT_OF_RANGE");
  if (features.lastMinuteVolumeLamports < features.precedingFourMinuteMeanVolumeLamports * 2) {
    reasons.push("VOLUME_ACCELERATION_TOO_LOW");
  }
  if (features.distinctBuyers5m < 20) reasons.push("INSUFFICIENT_DISTINCT_BUYERS");
  if (features.buyVolumeShareBps < 6_000) reasons.push("BUY_VOLUME_SHARE_TOO_LOW");
  if (features.largestFiveSecondReturnBps > 1_500) reasons.push("SINGLE_BUCKET_PUMP");
  return { action: reasons.length === 0 ? "enter" : "no_trade", reasons, features };
}

/** Stable candidate ordering: volume ratio, then five minute return, then mint. */
export function rankMomentumCandidates<T extends { mint: string; decision: EntryDecision }>(candidates: readonly T[]): T[] {
  return candidates
    .filter((candidate) => candidate.decision.action === "enter" && candidate.decision.features !== undefined)
    .slice()
    .sort((left, right) => {
      const leftFeatures = left.decision.features!;
      const rightFeatures = right.decision.features!;
      if (rightFeatures.volumeRatio !== leftFeatures.volumeRatio) return rightFeatures.volumeRatio - leftFeatures.volumeRatio;
      if (rightFeatures.return5mBps !== leftFeatures.return5mBps) return rightFeatures.return5mBps - leftFeatures.return5mBps;
      return left.mint.localeCompare(right.mint);
    });
}

export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "MAX_HOLD_TIME";
export interface ExitDecision { action: "exit" | "hold"; reasons: ExitReason[]; }
export interface ExitInput {
  /** Conservative executable proceeds after every exit cost, in lamports. */
  netExecutableValueLamports: bigint;
  entryCostLamports: bigint;
  peakNetExecutableValueLamports: bigint;
  openedAt: Date;
  now: Date;
}

export function evaluateExit(input: ExitInput): ExitDecision {
  if (input.entryCostLamports <= 0n) throw new Error("entry cost must be positive");
  const netReturnBps = Number(((input.netExecutableValueLamports - input.entryCostLamports) * 10_000n) / input.entryCostLamports);
  const peakReturnBps = Number(((input.peakNetExecutableValueLamports - input.entryCostLamports) * 10_000n) / input.entryCostLamports);
  const peakDrawdownBps = input.peakNetExecutableValueLamports <= 0n
    ? 10_000
    : Number(((input.peakNetExecutableValueLamports - input.netExecutableValueLamports) * 10_000n) / input.peakNetExecutableValueLamports);
  const reasons: ExitReason[] = [];
  if (netReturnBps >= 1_500) reasons.push("TAKE_PROFIT");
  if (netReturnBps <= -800) reasons.push("STOP_LOSS");
  if (peakReturnBps >= 800 && peakDrawdownBps >= 600) reasons.push("TRAILING_STOP");
  if (input.now.getTime() - input.openedAt.getTime() >= 20 * 60_000) reasons.push("MAX_HOLD_TIME");
  return { action: reasons.length > 0 ? "exit" : "hold", reasons };
}
