import { createInterface } from "node:readline";
import { executePaperOrder, type PaperFillConfig, type PaperOrder, type PaperQuote } from "./fills.js";

interface PaperInput { order: Omit<PaperOrder, "inputAmount" | "submittedAt"> & { inputAmount: string; submittedAt: string }; quotes: Array<Omit<PaperQuote, "inputAmount" | "expectedOutput" | "feeAmount" | "observedAt" | "sourceSlot"> & { inputAmount: string; expectedOutput: string; feeAmount: string; observedAt: string; sourceSlot: string }>; }
const config = JSON.parse(process.env.PAPER_FILL_CONFIG ?? '{"buyLatencyMs":1000,"sellLatencyMs":1000,"networkFeeLamports":"5000","priorityFeeLamports":"0","latencySlippageBps":25,"maxQuoteAgeMs":3000}') as Omit<PaperFillConfig, "networkFeeLamports" | "priorityFeeLamports"> & { networkFeeLamports: string; priorityFeeLamports: string };
const normalizedConfig: PaperFillConfig = { ...config, networkFeeLamports: BigInt(config.networkFeeLamports), priorityFeeLamports: BigInt(config.priorityFeeLamports) };
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const input = JSON.parse(line) as PaperInput;
  const order: PaperOrder = { ...input.order, inputAmount: BigInt(input.order.inputAmount), submittedAt: new Date(input.order.submittedAt) };
  const quotes: PaperQuote[] = input.quotes.map((quote) => ({ ...quote, inputAmount: BigInt(quote.inputAmount), expectedOutput: BigInt(quote.expectedOutput), feeAmount: BigInt(quote.feeAmount), observedAt: new Date(quote.observedAt), sourceSlot: BigInt(quote.sourceSlot) }));
  process.stdout.write(`${JSON.stringify(executePaperOrder(order, quotes, normalizedConfig), (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`);
}
