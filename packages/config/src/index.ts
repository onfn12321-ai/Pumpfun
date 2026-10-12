import { z } from "zod";

const percent = z.coerce.number().min(0).max(1);

export const configSchema = z
  .object({
    mode: z.enum(["replay", "paper", "live"]).default("paper"),
    databaseUrl: z.string().min(1),
    solanaRpcUrl: z.string().url(),
    controlToken: z.string().min(24),
    controlHost: z.string().default("127.0.0.1"),
    controlPort: z.coerce.number().int().min(1).max(65_535).default(8787),
    browserProfileDir: z.string().min(1),
    pumpOrigin: z.literal("https://pump.fun"),
    walletPublicKey: z.string().min(32),
    maxPositionPct: percent.max(0.05).default(0.0025),
    maxDailyLossPct: percent.max(0.1).default(0.01),
    maxTotalExposurePct: percent.max(0.4).default(0.02),
    maxSlippageBps: z.coerce.number().int().min(0).max(200).default(100),
    hardSlippageCeilingBps: z.coerce.number().int().min(0).max(200).default(200),
  })
  .superRefine((value, context) => {
    if (value.maxSlippageBps > value.hardSlippageCeilingBps) {
      context.addIssue({
        code: "custom",
        path: ["maxSlippageBps"],
        message: "maxSlippageBps must not exceed hardSlippageCeilingBps",
      });
    }
  });

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AgentConfig {
  return configSchema.parse({
    mode: environment.AGENT_MODE,
    databaseUrl: environment.DATABASE_URL,
    solanaRpcUrl: environment.SOLANA_RPC_URL,
    controlToken: environment.CONTROL_TOKEN,
    controlHost: environment.CONTROL_HOST,
    controlPort: environment.CONTROL_PORT,
    browserProfileDir: environment.BROWSER_PROFILE_DIR,
    pumpOrigin: environment.PUMP_ORIGIN,
    walletPublicKey: environment.WALLET_PUBLIC_KEY,
    maxPositionPct: environment.MAX_POSITION_PCT,
    maxDailyLossPct: environment.MAX_DAILY_LOSS_PCT,
    maxTotalExposurePct: environment.MAX_TOTAL_EXPOSURE_PCT,
    maxSlippageBps: environment.MAX_SLIPPAGE_BPS,
    hardSlippageCeilingBps: environment.HARD_SLIPPAGE_CEILING_BPS,
  });
}
