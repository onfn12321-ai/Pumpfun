import { createInterface } from "node:readline";
import { type CanonicalMarketEvent, type Commitment, type MarketEventKind, type MarketEventSource } from "./types.js";

type JsonEvent = Omit<CanonicalMarketEvent, "slot" | "chainTime" | "observedAt" | "commitment" | "source" | "kind"> & {
  slot: string | number;
  chainTime: string;
  observedAt: string;
  commitment: Commitment;
  source: MarketEventSource;
  kind: MarketEventKind;
  reserves?: { quoteReserveLamports: string | number; baseReserve: string | number; route: "bonding_curve" | "migrating" | "pumpswap" };
};

export function parseNdjsonEvent(value: unknown): CanonicalMarketEvent {
  const event = value as JsonEvent;
  return {
    ...event,
    slot: BigInt(event.slot),
    chainTime: new Date(event.chainTime),
    observedAt: new Date(event.observedAt),
    ...(event.reserves === undefined ? {} : {
      reserves: {
        ...event.reserves,
        quoteReserveLamports: BigInt(event.reserves.quoteReserveLamports),
        baseReserve: BigInt(event.reserves.baseReserve),
      },
    }),
  };
}

export async function readNdjson(input: NodeJS.ReadableStream = process.stdin): Promise<CanonicalMarketEvent[]> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const events: CanonicalMarketEvent[] = [];
  for await (const line of lines) {
    if (line.trim()) events.push(parseNdjsonEvent(JSON.parse(line)));
  }
  return events;
}

export function eventToJson(event: CanonicalMarketEvent): string {
  return JSON.stringify(event, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}
