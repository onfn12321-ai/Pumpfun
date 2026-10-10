import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

import { PublicKey } from "@solana/web3.js";

/**
 * Read-only Pump.fun market data decoded from public Solana program logs. It
 * needs no API key, never scrapes pump.fun pages, and never signs anything.
 */
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const DEFAULT_RPC_WS_URL = "wss://api.mainnet-beta.solana.com";

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_DECIMALS = 1_000_000;
/** Only standard SOL-quoted curves are accepted. Other quote mints fail closed. */
const STANDARD_INITIAL_VIRTUAL_SOL_LAMPORTS = 30_000_000_000n;
const STANDARD_INITIAL_VIRTUAL_TOKENS_RAW = 1_073_000_000_000_000n;

export interface RawPumpMessage {
  signature?: string;
  slot?: number;
  mint?: string;
  traderPublicKey?: string;
  txType?: "create" | "buy" | "sell" | "complete" | "stream_gap" | string;
  initialBuy?: number;
  solAmount?: number;
  tokenAmount?: number;
  newTokenBalance?: number;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  realTokensInBondingCurve?: number;
  pool?: string;
  name?: string;
  symbol?: string;
  message?: string;
}

export interface RecordedMessage {
  observedAt: number;
  data: RawPumpMessage;
}

function eventDiscriminator(name: string): string {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8).toString("hex");
}

const TRADE_EVENT = eventDiscriminator("TradeEvent");
const CREATE_EVENT = eventDiscriminator("CreateEvent");
const COMPLETE_EVENT = eventDiscriminator("CompleteEvent");

class Reader {
  offset = 8;
  constructor(private readonly buffer: Buffer) {}
  publicKey(): string {
    const key = new PublicKey(this.buffer.subarray(this.offset, this.offset + 32)).toBase58();
    this.offset += 32;
    return key;
  }
  u64(): bigint {
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
  bool(): boolean {
    const value = this.buffer[this.offset] === 1;
    this.offset += 1;
    return value;
  }
  string(): string {
    const length = this.buffer.readUInt32LE(this.offset);
    if (length > 512) throw new RangeError("string too long");
    this.offset += 4;
    const value = this.buffer.subarray(this.offset, this.offset + length).toString("utf8");
    this.offset += length;
    return value;
  }
}

/** Decodes one `Program data:` payload from the Pump program. Unknown events return undefined. */
export function decodePumpEvent(base64: string, signature?: string, slot?: number): RawPumpMessage | undefined {
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 8) return undefined;
  const discriminator = buffer.subarray(0, 8).toString("hex");
  try {
    const reader = new Reader(buffer);
    const meta = { ...(signature ? { signature } : {}), ...(slot !== undefined ? { slot } : {}) };
    if (discriminator === TRADE_EVENT) {
      const mint = reader.publicKey();
      const solAmount = reader.u64();
      const tokenAmount = reader.u64();
      const isBuy = reader.bool();
      const trader = reader.publicKey();
      reader.u64(); // on-chain timestamp
      const vSol = reader.u64();
      const vTokens = reader.u64();
      reader.u64(); // real SOL reserves
      const realTokens = reader.u64();
      return {
        ...meta,
        txType: isBuy ? "buy" : "sell",
        mint,
        traderPublicKey: trader,
        solAmount: Number(solAmount) / LAMPORTS_PER_SOL,
        tokenAmount: Number(tokenAmount) / TOKEN_DECIMALS,
        vSolInBondingCurve: Number(vSol) / LAMPORTS_PER_SOL,
        vTokensInBondingCurve: Number(vTokens) / TOKEN_DECIMALS,
        realTokensInBondingCurve: Number(realTokens) / TOKEN_DECIMALS,
        pool: "pump",
      };
    }
    if (discriminator === CREATE_EVENT) {
      const name = reader.string();
      const symbol = reader.string();
      reader.string(); // uri
      const mint = reader.publicKey();
      reader.publicKey(); // bonding curve
      reader.publicKey(); // signer
      const creator = reader.publicKey();
      reader.u64(); // timestamp
      const vTokens = reader.u64();
      const vSol = reader.u64();
      const standard = vSol === STANDARD_INITIAL_VIRTUAL_SOL_LAMPORTS && vTokens === STANDARD_INITIAL_VIRTUAL_TOKENS_RAW;
      return {
        ...meta,
        txType: "create",
        mint,
        traderPublicKey: creator,
        name,
        symbol,
        initialBuy: 0,
        vSolInBondingCurve: Number(vSol) / LAMPORTS_PER_SOL,
        vTokensInBondingCurve: Number(vTokens) / TOKEN_DECIMALS,
        pool: standard ? "pump" : "nonstandard",
      };
    }
    if (discriminator === COMPLETE_EVENT) {
      reader.publicKey(); // user
      const mint = reader.publicKey();
      return { ...meta, txType: "complete", mint };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface StreamOptions {
  url?: string;
  recordPath?: string;
  onMessage: (message: RecordedMessage) => void;
  onStatus?: (status: string) => void;
  /** Forces a reconnect, and therefore a recorded gap, after this much silence. */
  silenceTimeoutMs?: number;
}

export class PumpLogsStream {
  private socket: WebSocket | undefined;
  private recorder: WriteStream | undefined;
  private stopped = false;
  private reconnects = 0;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | undefined;
  /** Trades are kept only for curves whose standard create event was observed. */
  private readonly knownMints = new Set<string>();
  counts = { creates: 0, trades: 0, completes: 0, failedTransactions: 0, gaps: 0 };

  constructor(private readonly options: StreamOptions) {
    if (options.recordPath) {
      mkdirSync(dirname(options.recordPath), { recursive: true });
      this.recorder = createWriteStream(options.recordPath, { flags: "a" });
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
    const silence = this.options.silenceTimeoutMs ?? 30_000;
    this.watchdog = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt > silence) {
        this.options.onStatus?.("no data; forcing reconnect");
        this.socket.close();
      }
    }, 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.close();
    this.recorder?.end();
  }

  private connect(): void {
    const socket = new WebSocket(this.options.url ?? DEFAULT_RPC_WS_URL);
    this.socket = socket;
    socket.onopen = () => {
      this.lastMessageAt = Date.now();
      this.options.onStatus?.(`connected (reconnects=${this.reconnects})`);
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: "confirmed" }],
      }));
      // A reconnect creates an observation gap. Record it so consumers fail closed.
      if (this.reconnects > 0) {
        this.counts.gaps += 1;
        this.emit({ txType: "stream_gap", message: "reconnected" });
      }
    };
    socket.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      let payload: { params?: { result?: { context?: { slot?: number }; value?: { signature?: string; err: unknown; logs?: string[] } } } };
      try {
        payload = JSON.parse(String(event.data)) as typeof payload;
      } catch {
        return;
      }
      const result = payload.params?.result;
      const value = result?.value;
      if (!value?.logs) return;
      if (value.err !== null) {
        this.counts.failedTransactions += 1;
        return;
      }
      for (const line of value.logs) {
        if (!line.startsWith("Program data: ")) continue;
        const decoded = decodePumpEvent(line.slice(14), value.signature, result?.context?.slot);
        if (!decoded?.mint) continue;
        if (decoded.txType === "create") {
          if (decoded.pool !== "pump") continue;
          this.knownMints.add(decoded.mint);
          this.counts.creates += 1;
        } else if (!this.knownMints.has(decoded.mint)) {
          continue;
        } else if (decoded.txType === "complete") {
          this.counts.completes += 1;
        } else {
          this.counts.trades += 1;
        }
        this.emit(decoded);
      }
    };
    socket.onerror = () => this.options.onStatus?.("socket error");
    socket.onclose = () => {
      if (this.stopped) return;
      this.reconnects += 1;
      this.options.onStatus?.("disconnected; reconnecting in 3s");
      setTimeout(() => this.connect(), 3_000);
    };
  }

  private emit(data: RawPumpMessage): void {
    const message: RecordedMessage = { observedAt: Date.now(), data };
    this.recorder?.write(`${JSON.stringify(message)}\n`);
    this.options.onMessage(message);
  }
}
