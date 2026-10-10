import { describe, expect, it } from "vitest";

import { MarketState } from "./market.js";
import { decodePumpEvent } from "./stream.js";
import { BASE_CONFIG, PaperTrader } from "./trader.js";

const T0 = 1_800_000_000_000;
const MINT = "Mint1111111111111111111111111111111111pump";
const DECISION = T0 + 15 * 60_000;
const WINDOW_START = DECISION - 5 * 60_000;

/** Builds a constant-product market history that satisfies every momentum entry rule at DECISION. */
function qualifyingMarket(): { market: MarketState; buy: (at: number, trader: string, sol: number) => void } {
  const market = new MarketState();
  let vSol = 30;
  let vTokens = 1_073_000_000;
  const buy = (at: number, trader: string, sol: number): void => {
    const tokens = vTokens - (vSol * vTokens) / (vSol + sol);
    vSol += sol;
    vTokens -= tokens;
    market.apply(at, { txType: "buy", mint: MINT, traderPublicKey: trader, solAmount: sol, tokenAmount: tokens, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, pool: "pump" });
  };
  const sell = (at: number, trader: string, tokens: number): void => {
    const sol = vSol - (vSol * vTokens) / (vTokens + tokens);
    vSol -= sol;
    vTokens += tokens;
    market.apply(at, { txType: "sell", mint: MINT, traderPublicKey: trader, solAmount: sol, tokenAmount: tokens, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, pool: "pump" });
  };
  market.apply(T0, { txType: "create", mint: MINT, traderPublicKey: "creator", symbol: "TEST", initialBuy: 0, vSolInBondingCurve: 30, vTokensInBondingCurve: 1_073_000_000, pool: "pump" });
  // Broad early distribution: 50 holders, each well below the 5% holder cap.
  for (let index = 0; index < 50; index += 1) buy(T0 + 1_000 + index * 10_000, `early-${index}`, 0.5);
  // First four minutes of the window: steady buying and a few small sells.
  for (let index = 0; index < 24; index += 1) {
    buy(WINDOW_START + 1_000 + index * 10_000, `window-${index}`, 0.1);
    if (index % 3 === 0) sell(WINDOW_START + 6_000 + index * 10_000, `early-${index}`, 200_000);
  }
  // Last minute: accelerating buy volume.
  for (let index = 0; index < 12; index += 1) buy(WINDOW_START + 241_000 + index * 5_000, `late-${index}`, 0.25);
  return { market, buy };
}

describe("paper trader", () => {
  it("waits for the authority check, enters after latency, and exits at take profit", () => {
    const { market, buy } = qualifyingMarket();
    const trader = new PaperTrader({ ...BASE_CONFIG, name: "test", minRealSolReserves: 20 }, market);

    expect(trader.tick(DECISION, new Map())).toEqual([MINT]);
    expect(trader.positions.size).toBe(0);

    trader.tick(DECISION, new Map([[MINT, "ok"]]));
    expect(trader.rejectionCounts.ENTRY_SUBMITTED).toBe(1);
    expect(trader.positions.size).toBe(0);
    expect(trader.cashSol).toBeCloseTo(9.5, 6);

    trader.advanceTo(DECISION + BASE_CONFIG.latencyMs);
    expect(trader.positions.size).toBe(1);

    buy(DECISION + 2_000, "whale", 8);
    trader.tick(DECISION + 5_000, new Map([[MINT, "ok"]]));
    trader.advanceTo(DECISION + 5_000 + BASE_CONFIG.latencyMs);

    expect(trader.positions.size).toBe(0);
    expect(trader.closed).toHaveLength(1);
    expect(trader.closed[0]!.exitReasons).toContain("TAKE_PROFIT");
    expect(trader.closed[0]!.pnlSol).toBeGreaterThan(0);
    expect(trader.cashSol).toBeGreaterThan(10);
  });

  it("rejects candidates with active mint or freeze authority", () => {
    const { market } = qualifyingMarket();
    const trader = new PaperTrader({ ...BASE_CONFIG, name: "test", minRealSolReserves: 20 }, market);
    trader.tick(DECISION, new Map([[MINT, "reject"]]));
    expect(trader.rejectionCounts.MINT_AUTHORITY_REJECTED).toBe(1);
    expect(trader.rejectionCounts.ENTRY_SUBMITTED).toBeUndefined();
  });

  it("blocks entries after a stream gap", () => {
    const { market } = qualifyingMarket();
    market.apply(DECISION - 1_000, { txType: "stream_gap" });
    const trader = new PaperTrader({ ...BASE_CONFIG, name: "test", minRealSolReserves: 20 }, market);
    trader.tick(DECISION, new Map([[MINT, "ok"]]));
    expect(trader.rejectionCounts.STREAM_GAP_COOLDOWN).toBe(1);
    expect(trader.rejectionCounts.ENTRY_SUBMITTED).toBeUndefined();
  });

  it("applies the reserve threshold", () => {
    const { market } = qualifyingMarket();
    const trader = new PaperTrader({ ...BASE_CONFIG, name: "strict", minRealSolReserves: 100 }, market);
    trader.tick(DECISION, new Map([[MINT, "ok"]]));
    expect(trader.rejectionCounts.INSUFFICIENT_EXECUTABLE_RESERVES).toBe(1);
  });

  it("fails the buy when the market moves beyond slippage before the fill", () => {
    const { market, buy } = qualifyingMarket();
    const trader = new PaperTrader({ ...BASE_CONFIG, name: "test", minRealSolReserves: 20 }, market);
    trader.tick(DECISION, new Map([[MINT, "ok"]]));
    buy(DECISION + 500, "front-runner", 3);
    trader.advanceTo(DECISION + BASE_CONFIG.latencyMs);
    expect(trader.positions.size).toBe(0);
    expect(trader.failedTransactions).toBe(1);
    expect(trader.cashSol).toBeLessThan(10);
    expect(trader.cashSol).toBeGreaterThan(9.99);
  });
});

describe("pump event decoder", () => {
  it("decodes a recorded mainnet create event", () => {
    const payload = "G3KpTd7rY3YGAAAATm9haEFJBgAAAE5vYWhBSVAAAABodHRwczovL2lwZnMuaW8vaXBmcy9iYWZrcmVpYmYyamF2d3MyMmxzaWJiZ3B5ajJpeGNmdnlwZjRtdWNqN2U2emY3c3lwbmtpc3B0NjIzcR4+4/odUk1jN3pVBwVw8UWt/yf/eiK7jZB6VfKQHEsP56UtlffxDVxMpPeIsgnI1w2dDwts2X7Gie2UxOi2anx6NnhxHzyFzy4MWZUXPSMy6JTXuAJFViPohsyc+fI8ino2eHEfPIXPLgxZlRc9IzLolNe4AkVWI+iGzJz58jyKZGjKagAAAAAAENhH488DAACsI/wGAAAAAHjF+1HRAgAAgMakfo0DAAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACsI/wGAAAAAAAAAAAAAAAAAA==";
    const event = decodePumpEvent(payload, "sig", 1);
    expect(event).toMatchObject({
      txType: "create",
      mint: "334rPvNk48wQEKiVunLDMV8e3HocwuofzXxZburjpump",
      symbol: "NoahAI",
      traderPublicKey: "9E4uxeDmfNHXPJUvraYPHE8YUMCQPjGkp3SCctzAkREH",
      vSolInBondingCurve: 30,
      vTokensInBondingCurve: 1_073_000_000,
      pool: "pump",
      signature: "sig",
    });
  });

  it("decodes a recorded mainnet buy event in SOL and token units", () => {
    const payload = "vdt/007mYe4ePuP6HVJNYzd6VQcFcPFFrf8n/3oiu42QelXykBxLDwCrkEEAAAAAKOutVYQiAAABejZ4cR88hc8uDFmVFz0jMuiU17gCRVYj6IbMnPnyPIpkaMpqAAAAAABXtD0HAAAA2CQq8l6tAwAAq5BBAAAAANiMF6bNrgIASsL40N1cvJfjKJwZfLUGKlTz2Va5zm5RFfllZ6pcs+ZfAAAAAAAAAFB0nwAAAAAAejZ4cR88hc8uDFmVFz0jMuiU17gCRVYj6IbMnPnyPIoeAAAAAAAAAKBaMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAGJ1eQAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAAAouk8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACrkEEAAAAAAFe0PQcAAAAAq5BBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const event = decodePumpEvent(payload);
    expect(event?.txType).toBe("buy");
    expect(event?.mint).toBe("334rPvNk48wQEKiVunLDMV8e3HocwuofzXxZburjpump");
    expect(event?.traderPublicKey).toBe("9E4uxeDmfNHXPJUvraYPHE8YUMCQPjGkp3SCctzAkREH");
    expect(event?.solAmount).toBeGreaterThan(1);
    expect(event?.vSolInBondingCurve).toBeCloseTo(30 + event!.solAmount!, 1);
    expect(event?.tokenAmount).toBeGreaterThan(0);
  });

  it("ignores unknown discriminators and truncated payloads", () => {
    expect(decodePumpEvent(Buffer.from("0102030405060708", "hex").toString("base64"))).toBeUndefined();
    expect(decodePumpEvent(Buffer.from("bddb7fd34ee661ee00", "hex").toString("base64"))).toBeUndefined();
  });
});

describe("small paper wallet", () => {
  it("sizes a 0.5 SOL wallet at 0.025 SOL and returns a refundable account deposit", () => {
    const { market, buy } = qualifyingMarket();
    const trader = new PaperTrader({ ...BASE_CONFIG, name: "small", startingBalanceSol: 0.5, feeReserveSol: 0.025, minRealSolReserves: 20 }, market);
    trader.tick(DECISION, new Map([[MINT, "ok"]]));
    trader.advanceTo(DECISION + BASE_CONFIG.latencyMs);
    const position = [...trader.positions.values()][0]!;
    expect(position.entryCostSol).toBeCloseTo(0.025 + 0.000205, 6);
    expect(trader.cashSol).toBeCloseTo(0.5 - 0.025 - 0.000205 - BASE_CONFIG.tokenAccountRentSol, 6);
    buy(DECISION + 2_000, "whale", 8);
    trader.tick(DECISION + 5_000, new Map([[MINT, "ok"]]));
    trader.advanceTo(DECISION + 5_000 + BASE_CONFIG.latencyMs);
    expect(trader.closed).toHaveLength(1);
    expect(trader.cashSol).toBeCloseTo(0.5 + trader.closed[0]!.pnlSol, 9);
  });

  it("refuses a 0.025 SOL trade when the account deposit is not refunded", () => {
    const { market } = qualifyingMarket();
    const small = { ...BASE_CONFIG, startingBalanceSol: 0.5, feeReserveSol: 0.025, minRealSolReserves: 20 };
    const trader = new PaperTrader({ ...small, name: "no-refund", rentRefundedOnExit: false }, market);
    trader.tick(DECISION, new Map([[MINT, "ok"]]));
    expect(trader.rejectionCounts.COST_HURDLE_NOT_MET).toBe(1);
    expect(trader.rejectionCounts.ENTRY_SUBMITTED).toBeUndefined();

    // The same lost deposit is affordable on a 10 SOL wallet, where it is a cost in the entry basis.
    const large = new PaperTrader({ ...BASE_CONFIG, name: "large-no-refund", minRealSolReserves: 20, rentRefundedOnExit: false }, market);
    large.tick(DECISION, new Map([[MINT, "ok"]]));
    large.advanceTo(DECISION + BASE_CONFIG.latencyMs);
    expect([...large.positions.values()][0]!.entryCostSol).toBeCloseTo(0.5 + 0.000205 + BASE_CONFIG.tokenAccountRentSol, 6);
  });
});
