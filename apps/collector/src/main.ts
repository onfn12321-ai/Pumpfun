import { buildFiveSecondBuckets } from "./buckets.js";
import { MarketEventCapture } from "./capture.js";
import { eventToJson, readNdjson } from "./ndjson.js";

const events = await readNdjson();
const capture = new MarketEventCapture();
const accepted = events.flatMap((event) => capture.ingest(event).event ?? []);
const asOf = new Date(Number(process.env.AS_OF_MS ?? Date.now()));
for (const bucket of buildFiveSecondBuckets(accepted, { availableAt: asOf, commitment: "confirmed" })) {
  process.stdout.write(`${JSON.stringify(bucket)}\n`);
}
for (const source of ["browser", "rpc", "indexer", "fixture"] as const) {
  const health = capture.health(source);
  if (!health.healthy) process.stderr.write(`${eventToJson({
    eventId: `stream-health-${source}`,
    kind: "route_change",
    mint: "system",
    source,
    slot: health.highWatermarkSlot ?? 0n,
    chainTime: asOf,
    observedAt: asOf,
    commitment: "processed",
    rawPayloadRef: "stream-health",
    decoderVersion: "collector-cli-v1",
  })}\n`);
}
