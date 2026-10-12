import {
  type CanonicalMarketEvent,
  type CaptureResult,
  type MarketEventSource,
  type StreamGap,
  type StreamHealth,
} from "./types.js";

function chainIdentity(event: CanonicalMarketEvent): string {
  if (event.signature !== undefined && event.instructionIndex !== undefined) {
    return `${event.signature}:${event.instructionIndex}`;
  }
  return event.eventId;
}

/**
 * In-memory capture guard. Production persistence should enforce the same keys
 * with unique constraints before an event is published to consumers.
 */
export class MarketEventCapture {
  private readonly eventIds = new Set<string>();
  private readonly identities = new Set<string>();
  private readonly watermarks = new Map<MarketEventSource, bigint>();
  private readonly gaps: StreamGap[] = [];

  ingest(event: CanonicalMarketEvent): CaptureResult {
    const validationError = validateEvent(event);
    if (validationError !== undefined) return { accepted: false, duplicate: false, reason: validationError };

    const identity = chainIdentity(event);
    if (this.eventIds.has(event.eventId) || this.identities.has(identity)) {
      return { accepted: false, duplicate: true, reason: "duplicate_chain_identity" };
    }

    const watermark = this.watermarks.get(event.source);
    if (watermark !== undefined && event.slot < watermark) {
      this.recordGap(event.source, event.slot, watermark, "slot_regression", event.observedAt);
      return { accepted: false, duplicate: false, reason: "slot_regression" };
    }

    this.eventIds.add(event.eventId);
    this.identities.add(identity);
    this.watermarks.set(event.source, event.slot);
    return { accepted: true, duplicate: false, event };
  }

  /** Call on a disconnected subscription; a successful backfill may clear its operational halt externally. */
  recordDisconnect(source: MarketEventSource, lastKnownSlot: bigint, resumedAt: Date): StreamGap {
    const gap: StreamGap = {
      source,
      fromSlot: lastKnownSlot,
      toSlot: lastKnownSlot,
      detectedAt: resumedAt,
      reason: "disconnect",
    };
    this.gaps.push(gap);
    return gap;
  }

  recordBackfillFailure(source: MarketEventSource, fromSlot: bigint, toSlot: bigint, detectedAt: Date): StreamGap {
    return this.recordGap(source, fromSlot, toSlot, "backfill_failed", detectedAt);
  }

  health(source: MarketEventSource): StreamHealth {
    const gaps = this.gaps.filter((gap) => gap.source === source);
    return {
      source,
      ...(this.watermarks.has(source) ? { highWatermarkSlot: this.watermarks.get(source)! } : {}),
      gaps,
      healthy: gaps.length === 0,
    };
  }

  private recordGap(
    source: MarketEventSource,
    fromSlot: bigint,
    toSlot: bigint,
    reason: StreamGap["reason"],
    detectedAt: Date,
  ): StreamGap {
    const gap = { source, fromSlot, toSlot, detectedAt, reason };
    this.gaps.push(gap);
    return gap;
  }
}

export function validateEvent(event: CanonicalMarketEvent): string | undefined {
  if (!event.eventId || !event.mint || !event.rawPayloadRef || !event.decoderVersion) return "missing_required_identity";
  if (!Number.isFinite(event.chainTime.getTime()) || !Number.isFinite(event.observedAt.getTime())) return "invalid_timestamp";
  if (event.observedAt < event.chainTime) return "observation_before_chain_time";
  if (event.slot < 0n) return "invalid_slot";
  if (event.kind === "trade") {
    if (event.trade === undefined) return "missing_trade_payload";
    if (event.trade.priceSol <= 0 || event.trade.volumeSol <= 0 || !event.trade.buyer) return "invalid_trade_payload";
  }
  return undefined;
}
