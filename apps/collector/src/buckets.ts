import type { MarketBucket } from "../../../packages/shared/src/index.js";
import type { CanonicalMarketEvent } from "./types.js";

export const FIVE_SECONDS_MS = 5_000;

export interface BucketBuildOptions {
  /** Only events known by this instant are eligible. This is the replay no-look-ahead boundary. */
  availableAt: Date;
  commitment?: "confirmed" | "finalized";
}

export interface TimedMarketBucket extends MarketBucket {
  /** The latest observation used to build this bucket. */
  availableAt: Date;
  eventIds: readonly string[];
}

function bucketStart(time: Date): number {
  return Math.floor(time.getTime() / FIVE_SECONDS_MS) * FIVE_SECONDS_MS;
}

/** Builds non-overlapping, event-time buckets from observations available at the requested time. */
export function buildFiveSecondBuckets(
  events: readonly CanonicalMarketEvent[],
  options: BucketBuildOptions,
): TimedMarketBucket[] {
  const deduplicated = new Map<string, CanonicalMarketEvent>();
  for (const event of events) {
    if (event.kind !== "trade" || event.trade === undefined) continue;
    if (event.observedAt > options.availableAt) continue;
    if (options.commitment !== undefined && event.commitment !== options.commitment) continue;
    const chainKey = event.signature !== undefined && event.instructionIndex !== undefined
      ? `${event.signature}:${event.instructionIndex}`
      : event.eventId;
    if (!deduplicated.has(chainKey)) deduplicated.set(chainKey, event);
  }

  const grouped = new Map<string, CanonicalMarketEvent[]>();
  for (const event of deduplicated.values()) {
    const key = `${event.mint}:${bucketStart(event.chainTime)}`;
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [event]);
    else group.push(event);
  }

  return [...grouped.values()]
    .map((trades) => {
      trades.sort((left, right) => left.chainTime.getTime() - right.chainTime.getTime() || left.eventId.localeCompare(right.eventId));
      const first = trades[0]!;
      const start = bucketStart(first.chainTime);
      let buyVolumeSol = 0;
      let sellVolumeSol = 0;
      let high = -Infinity;
      let low = Infinity;
      let latestObservedAt = new Date(0);
      const buyers = new Set<string>();
      for (const tradeEvent of trades) {
        const trade = tradeEvent.trade!;
        if (trade.side === "buy") {
          buyVolumeSol += trade.volumeSol;
          buyers.add(trade.buyer);
        } else sellVolumeSol += trade.volumeSol;
        high = Math.max(high, trade.priceSol);
        low = Math.min(low, trade.priceSol);
        if (tradeEvent.observedAt > latestObservedAt) latestObservedAt = tradeEvent.observedAt;
      }
      return {
        mint: first.mint,
        startedAt: new Date(start),
        closedAt: new Date(start + FIVE_SECONDS_MS),
        openPriceSol: first.trade!.priceSol,
        closePriceSol: trades.at(-1)!.trade!.priceSol,
        highPriceSol: high,
        lowPriceSol: low,
        buyVolumeSol,
        sellVolumeSol,
        distinctBuyers: buyers.size,
        availableAt: latestObservedAt,
        eventIds: trades.map((event) => event.eventId),
      } satisfies TimedMarketBucket;
    })
    .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime() || left.mint.localeCompare(right.mint));
}
