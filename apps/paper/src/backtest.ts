import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { AuthorityChecker } from "./authority.js";
import { resolveEndpoints } from "./endpoints.js";
import type { RecordedMessage } from "./stream.js";
import { PaperSession } from "./session.js";
import { defaultVariants } from "./trader.js";

/**
 * Replays recorded market messages in observation order and runs the same paper
 * engine as live mode. Decisions happen only at five-second boundaries, using
 * messages observed before each boundary.
 */
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: tsx apps/paper/src/backtest.ts <recording.ndjson> [...]");
  process.exit(2);
}
const outputDir = process.env.OUTPUT_DIR ?? "data/backtest/latest";
const rpcUrl = resolveEndpoints().httpUrl;
const session = new PaperSession(defaultVariants(Number(process.env.STARTING_BALANCE_SOL ?? "0.5")));
const authority = new AuthorityChecker(rpcUrl, "data/cache/mint-authorities.json");

let nextTick: number | undefined;
let lastObserved = 0;
let outOfOrder = 0;

async function runTicksBefore(time: number): Promise<void> {
  while (nextTick !== undefined && nextTick <= time) {
    const needed = session.tick(nextTick, authority.statuses);
    // Live mode starts the check now and uses the result on a later tick. Mirror that delay.
    if (needed.length > 0) await authority.check(needed);
    nextTick += 5_000;
  }
}

for (const file of files) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: RecordedMessage;
    try {
      message = JSON.parse(line) as RecordedMessage;
    } catch {
      continue; // a partially written final line
    }
    if (message.observedAt < lastObserved) {
      outOfOrder += 1;
      continue;
    }
    lastObserved = message.observedAt;
    nextTick ??= Math.ceil(message.observedAt / 5_000) * 5_000;
    await runTicksBefore(message.observedAt);
    session.ingest(message);
  }
}
await runTicksBefore(lastObserved + 5_000);
session.writeReport(outputDir);

const summary = session.summary() as { durationMinutes: number; messages: number; traders: Array<Record<string, unknown>> };
console.log(`backtest: ${summary.durationMinutes} minutes, ${summary.messages} messages, skipped out-of-order=${outOfOrder}`);
for (const trader of session.traders) {
  const snapshot = trader.snapshot();
  console.log(`${snapshot.name}: equity=${snapshot.equitySol.toFixed(4)} SOL return=${snapshot.returnPct.toFixed(2)}% closed=${snapshot.closedTrades} wins=${snapshot.wins} losses=${snapshot.losses} open=${snapshot.openPositions} failedTx=${snapshot.failedTransactions}`);
}
console.log(`report: ${outputDir}`);
