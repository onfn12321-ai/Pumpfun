# Pump.fun browser trading agent

This project is a fail-closed research and execution framework for a deterministic Solana momentum strategy.

Profit is not guaranteed. A funded wallet can lose its full balance. Browser latency, fees, manipulation, and unavailable liquidity can make exits worse than configured stops.

## Safety status

The default mode is `paper`. Live mode stays blocked until all release gates pass.

Live operation requires:

- written confirmation that the intended browser automation complies with current pump.fun and wallet terms;
- a dedicated, limited-balance wallet that never receives automatic top-ups;
- a reviewed wallet adapter that binds the inspected transaction digest to the signed transaction;
- verified buy and sell paths for bonding-curve and PumpSwap routes;
- successful historical, paper, failure-injection, and limited-live gates;
- operator-tested entry halt, execution halt, reconciliation, and wallet recovery procedures.

The agent never bypasses CAPTCHAs, geoblocks, identity checks, rate limits, or anti-bot controls. It rejects unknown transaction instructions and arbitrary message-signing requests.

## Modes

- `replay` evaluates frozen strategy settings against event-time historical data.
- `paper` consumes current or recorded observations and simulates cost-aware fills.
- `live` uses the browser executor only after an explicit gate record and operator enablement.

The selected aggressive limits are hard ceilings: 5% per position, 10% daily loss, and 40% total exposure. The initial live-validation profile is 0.25%, 1%, and 2%.

## Local setup

Requirements:

- Node.js 22 or later
- PostgreSQL 16 or later
- A permitted Solana RPC or licensed indexer

Copy `.env.example` to `.env`. Set a dedicated wallet public key and a random control token. Never store a recovery phrase or wallet password in the file.

```bash
npm install
npm run check
npm test
docker compose up -d postgres
psql "$DATABASE_URL" -f db/migrations/001_initial.sql
npm run start:paper
```

The control service binds to `127.0.0.1` by default. Never expose the browser debugging port or the control service publicly.

## Live paper trading and backtests

These commands use only public, read-only data. They have no wallet, no key, and no order path.

```bash
# Live paper trading. Writes data/paper/<RUN_ID>/{summary.json,trades.csv,market.ndjson}.
RUN_ID=my-run DURATION_MINUTES=240 npm run paper:live

# Replay a recording through the same engine.
OUTPUT_DIR=data/backtest/my-run npm run paper:backtest -- data/paper/my-run/market.ndjson
```

- The market feed is Pump.fun program logs from Solana `logsSubscribe`. The default is the public mainnet endpoint. Set `SOLANA_WS_URL` and `SOLANA_RPC_URL` for a dedicated RPC.
- The feed sees only tokens created after it starts. A token can trade 10 minutes after the feed sees its creation.
- Holder shares come from observed curve trades only. Wallet-to-wallet transfers are not seen.
- Mint and freeze authority checks use `getAccountInfo`. A failed check blocks the entry.
- Fills use the reserves visible after the modeled latency, the 1.25% trading fee, extra latency slippage, network and priority fees, and the slippage limit. A fill outside the slippage limit fails and costs the network fee.
- Four portfolios run side by side. Each starts with `STARTING_BALANCE_SOL` paper SOL (default 0.5) and uses the aggressive limits (5% per position, 10% daily loss, 40% exposure). At 0.5 SOL, one position is 0.025 SOL.
- Each first buy of a token pays a token-account deposit of about 0.00207 SOL. The deposit comes back only if the sell closes the account.
  - `approved-strict` uses the approved 100 SOL reserve filter. A Pump.fun curve graduates near 85 real SOL, so this portfolio cannot enter on the bonding curve.
  - `exploratory-20sol` lowers the reserve filter to 20 real SOL. This change is not approved for live use.
  - `exploratory-20sol-2x-costs` doubles latency, latency slippage, priority fee, and the migration penalty.
  - `exploratory-20sol-no-refund` assumes the deposit does not come back. At 0.025 SOL per position, the deposit is about 8% of the trade, so the cost hurdle blocks every entry.
- A few hours of results do not satisfy the release gates and do not predict future results.

## Architecture

- `apps/collector` normalizes permitted observations and decoded on-chain events.
- `packages/market` calculates deterministic market features.
- `packages/strategy` creates reason-coded trade decisions.
- `packages/risk` enforces token, quote, position, exposure, and daily-loss controls.
- `apps/executor` owns the browser and wallet approval boundary.
- `apps/reconciler` verifies signatures and actual wallet deltas against Solana RPC.
- `apps/replay` and `apps/paper` evaluate the same deterministic decisions without signing.
- `apps/control` exposes authenticated private halt and resume controls.
- PostgreSQL provides durable intent, attempt, fill, ledger, and control state.

## Operating rules

1. Identify every asset by mint address.
2. Persist an intent before any browser side effect.
3. Treat an approval timeout as uncertain.
4. Never retry an uncertain transaction until independent reconciliation resolves it.
5. Calculate stops from executable liquidation proceeds after costs.
6. Keep a separate SOL reserve for fees and attempted exits.
7. Fail closed on stale data, route changes, selector drift, unknown instructions, or accounting mismatches.
8. Require operator review before any restart resumes signing.

## Release gates

Historical evaluation requires at least 30 out-of-sample days and 200 closed trades. Paper evaluation requires 14 consecutive days and 100 round trips. Both require positive net expectancy, profit factor of at least 1.2, and drawdown below 10%.

The first live profile uses 0.25% per position, 1% daily loss, and 2% exposure. Do not increase limits before seven days, 30 settled live round trips, positive net expectancy after costs, and zero unresolved transactions or hard-control violations.

See `docs/operations.md` for operator procedures and `docs/release-gates.md` for evidence requirements.
