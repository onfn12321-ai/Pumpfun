import { buildFiveSecondBuckets, type CanonicalMarketEvent, type TimedMarketBucket } from "../../collector/src/index.js";

export interface HistoricalFields {
  mint: string;
  availableAt: Date;
  reserveObservedAt?: Date;
  feeObservedAt?: Date;
  holderStateObservedAt?: Date;
  walletLinkageObservedAt?: Date;
  uiQuoteObservedAt?: Date;
  streamHealthy: boolean;
}

export interface ReplayFrame {
  bucket: TimedMarketBucket;
  /** This is the earliest clock time at which every included trade was observable. */
  availableAt: Date;
  historical: HistoricalFields | undefined;
}

export interface ReplayDecision {
  action: "enter" | "exit" | "hold" | "blocked";
  reasons: string[];
}

export interface ReplayResult {
  frames: readonly ReplayFrame[];
  decisions: readonly { frame: ReplayFrame; decision: ReplayDecision }[];
  blockedFrames: number;
}

export type ReplayStrategy = (frame: ReplayFrame) => ReplayDecision;

const REQUIRED_HISTORY: readonly (keyof Pick<HistoricalFields,
  "reserveObservedAt" | "feeObservedAt" | "holderStateObservedAt" | "walletLinkageObservedAt" | "uiQuoteObservedAt"
>)[] = ["reserveObservedAt", "feeObservedAt", "holderStateObservedAt", "walletLinkageObservedAt", "uiQuoteObservedAt"];

/** Reasons that prevent a historical decision from being treated as evidence for a release gate. */
export function requiredHistoryMissing(frame: ReplayFrame): string[] {
  const historical = frame.historical;
  if (historical === undefined) return ["missing_historical_state"];
  const reasons: string[] = [];
  if (!historical.streamHealthy) reasons.push("stream_gap");
  for (const field of REQUIRED_HISTORY) {
    const value = historical[field];
    if (value === undefined) reasons.push(`missing_${field}`);
    else if (value > frame.availableAt) reasons.push(`future_${field}`);
  }
  return reasons;
}

/**
 * Replays only completed buckets. Bucket contents are released at their own
 * observation time, not their chain timestamp, so an offline dataset cannot
 * accidentally make a late observation available to an earlier decision.
 */
export function replayHistorical(
  events: readonly CanonicalMarketEvent[],
  history: readonly HistoricalFields[],
  strategy: ReplayStrategy,
): ReplayResult {
  const finalAvailability = events.reduce(
    (latest, event) => event.observedAt > latest ? event.observedAt : latest,
    new Date(0),
  );
  const buckets = buildFiveSecondBuckets(events, { availableAt: finalAvailability, commitment: "confirmed" });
  const historyByMint = new Map(history.map((entry) => [entry.mint, entry]));
  const frames = buckets
    .map((bucket) => ({
      bucket,
      availableAt: bucket.availableAt > bucket.closedAt ? bucket.availableAt : bucket.closedAt,
      historical: historyByMint.get(bucket.mint),
    }))
    .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime()
      || left.bucket.startedAt.getTime() - right.bucket.startedAt.getTime()
      || left.bucket.mint.localeCompare(right.bucket.mint));

  const decisions = frames.map((frame) => {
    const blocked = requiredHistoryMissing(frame);
    return {
      frame,
      decision: blocked.length > 0 ? { action: "blocked" as const, reasons: blocked } : strategy(frame),
    };
  });
  return { frames, decisions, blockedFrames: decisions.filter(({ decision }) => decision.action === "blocked").length };
}
