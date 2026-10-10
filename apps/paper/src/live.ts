import { AuthorityChecker } from "./authority.js";
import { PumpLogsStream } from "./stream.js";
import { PaperSession } from "./session.js";
import { defaultVariants } from "./trader.js";

/**
 * Live paper trading. It consumes public read-only market data and simulates
 * fills. It has no wallet, no signing key, and no order submission path.
 */
const runId = process.env.RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = process.env.OUTPUT_DIR ?? `data/paper/${runId}`;
const durationMs = Number(process.env.DURATION_MINUTES ?? "0") * 60_000;
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const session = new PaperSession(defaultVariants(Number(process.env.STARTING_BALANCE_SOL ?? "0.5")));
const authority = new AuthorityChecker(rpcUrl, "data/cache/mint-authorities.json");
const stream = new PumpLogsStream({
  ...(process.env.SOLANA_WS_URL ? { url: process.env.SOLANA_WS_URL } : {}),
  recordPath: `${outputDir}/market.ndjson`,
  onMessage: (message) => session.ingest(message),
  onStatus: (status) => console.log(`[${new Date().toISOString()}] stream ${status}`),
});

function scheduleTick(): NodeJS.Timeout {
  const delay = 5_000 - (Date.now() % 5_000) + 5;
  return setTimeout(() => {
    const now = Math.floor(Date.now() / 5_000) * 5_000;
    const needed = session.tick(now, authority.statuses);
    if (needed.length > 0) void authority.check(needed);
    timer = scheduleTick();
  }, delay);
}

let timer = scheduleTick();
stream.start();
console.log(`live paper trading started; output=${outputDir}`);

const reporter = setInterval(() => {
  session.writeReport(outputDir);
  const line = session.traders
    .map((trader) => {
      const snapshot = trader.snapshot();
      return `${snapshot.name}: equity=${snapshot.equitySol.toFixed(4)} SOL (${snapshot.returnPct.toFixed(2)}%) open=${snapshot.openPositions} closed=${snapshot.closedTrades}`;
    })
    .join(" | ");
  console.log(`[${new Date().toISOString()}] tokens=${session.market.tokens.size} trades=${stream.counts.trades} gaps=${stream.counts.gaps} ${line}`);
}, 60_000);

function shutdown(): void {
  clearTimeout(timer);
  clearInterval(reporter);
  stream.stop();
  session.writeReport(outputDir);
  console.log(`stopped; report written to ${outputDir}`);
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (durationMs > 0) setTimeout(shutdown, durationMs);
