import { redactUrl, resolveEndpoints } from "./endpoints.js";
import { PumpLogsStream } from "./stream.js";

const endpoints = resolveEndpoints();
console.log(`feed endpoints: ${endpoints.wsUrls.map(redactUrl).join(", ")}`);

/** Records decoded Pump.fun events for later backtests. Read-only. */
const recordPath = process.env.RECORD_PATH ?? `data/recordings/pump-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
const durationMs = Number(process.env.DURATION_MINUTES ?? "0") * 60_000;

const stream = new PumpLogsStream({
  urls: endpoints.wsUrls,
  recordPath,
  onMessage: () => undefined,
  onStatus: (status) => console.log(`[${new Date().toISOString()}] ${status}`),
});

stream.start();
console.log(`recording to ${recordPath}`);
const progress = setInterval(() => console.log(`[${new Date().toISOString()}] ${JSON.stringify(stream.counts)}`), 60_000);

function shutdown(): void {
  clearInterval(progress);
  stream.stop();
  console.log(`stopped: ${JSON.stringify(stream.counts)}`);
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (durationMs > 0) setTimeout(shutdown, durationMs);
