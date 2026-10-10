import { describe, expect, it } from "vitest";

import { configSchema } from "./index.js";

const validConfig = {
  mode: "paper",
  databaseUrl: "postgres://local/test",
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  controlToken: "a-secure-control-token-value",
  browserProfileDir: "./browser-profile",
  pumpOrigin: "https://pump.fun",
  walletPublicKey: "11111111111111111111111111111111",
};

describe("agent configuration", () => {
  it("uses the reduced initial profile by default", () => {
    const result = configSchema.parse(validConfig);

    expect(result.maxPositionPct).toBe(0.0025);
    expect(result.maxDailyLossPct).toBe(0.01);
    expect(result.maxTotalExposurePct).toBe(0.02);
  });

  it("rejects values above the approved hard ceilings", () => {
    expect(() => configSchema.parse({ ...validConfig, maxPositionPct: 0.051 })).toThrow();
    expect(() => configSchema.parse({ ...validConfig, maxDailyLossPct: 0.101 })).toThrow();
    expect(() => configSchema.parse({ ...validConfig, maxTotalExposurePct: 0.401 })).toThrow();
  });

  it("rejects slippage above the independent hard ceiling", () => {
    expect(() =>
      configSchema.parse({
        ...validConfig,
        maxSlippageBps: 150,
        hardSlippageCeilingBps: 100,
      }),
    ).toThrow(/must not exceed/);
  });
});
