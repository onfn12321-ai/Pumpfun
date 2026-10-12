import { readNdjson } from "../../collector/src/ndjson.js";
import { replayHistorical, type HistoricalFields } from "./replay.js";

const events = await readNdjson();
const history = JSON.parse(process.env.HISTORICAL_FIELDS_JSON ?? "[]") as HistoricalFields[];
const result = replayHistorical(events, history.map((entry) => ({
  ...entry,
  availableAt: new Date(entry.availableAt),
  ...(entry.reserveObservedAt === undefined ? {} : { reserveObservedAt: new Date(entry.reserveObservedAt) }),
  ...(entry.feeObservedAt === undefined ? {} : { feeObservedAt: new Date(entry.feeObservedAt) }),
  ...(entry.holderStateObservedAt === undefined ? {} : { holderStateObservedAt: new Date(entry.holderStateObservedAt) }),
  ...(entry.walletLinkageObservedAt === undefined ? {} : { walletLinkageObservedAt: new Date(entry.walletLinkageObservedAt) }),
  ...(entry.uiQuoteObservedAt === undefined ? {} : { uiQuoteObservedAt: new Date(entry.uiQuoteObservedAt) }),
})), (frame) => ({ action: "hold", reasons: [`replay_bucket:${frame.bucket.startedAt.toISOString()}`] }));
for (const item of result.decisions) process.stdout.write(`${JSON.stringify(item)}\n`);
