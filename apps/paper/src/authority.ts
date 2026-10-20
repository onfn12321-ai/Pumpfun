import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AuthorityStatus } from "./trader.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Token-2022 extensions reviewed for pump.fun launches. Anything else fails closed. */
const ALLOWED_EXTENSIONS = new Set(["metadataPointer", "tokenMetadata"]);

interface ParsedMint {
  value: {
    owner: string;
    data: { parsed?: { info?: { mintAuthority: string | null; freezeAuthority: string | null; extensions?: Array<{ extension: string }> } } };
  } | null;
}

/** Read-only on-chain mint checks with a persistent cache. */
export class AuthorityChecker {
  private readonly cache = new Map<string, AuthorityStatus>();
  private readonly inFlight = new Set<string>();
  readonly reasons = new Map<string, string>();

  constructor(private readonly rpcUrl: string, private readonly cachePath?: string) {
    if (cachePath && existsSync(cachePath)) {
      const stored = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, AuthorityStatus>;
      for (const [mint, status] of Object.entries(stored)) this.cache.set(mint, status);
    }
  }

  get statuses(): ReadonlyMap<string, AuthorityStatus> {
    return this.cache;
  }

  async check(mints: readonly string[]): Promise<void> {
    const todo = mints.filter((mint) => !this.cache.has(mint) && !this.inFlight.has(mint));
    for (const mint of todo) this.inFlight.add(mint);
    await Promise.all(todo.map(async (mint) => {
      try {
        const status = await this.fetchStatus(mint);
        if (status) this.cache.set(mint, status);
      } finally {
        this.inFlight.delete(mint);
      }
    }));
    if (todo.length > 0) this.persist();
  }

  private async fetchStatus(mint: string): Promise<AuthorityStatus | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(this.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }] }),
          signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          continue;
        }
        const body = await response.json() as { result?: ParsedMint };
        const value = body.result?.value;
        if (!value) return this.reject(mint, "MINT_ACCOUNT_MISSING");
        if (value.owner !== TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM) return this.reject(mint, "UNKNOWN_TOKEN_PROGRAM");
        const info = value.data.parsed?.info;
        if (!info) return this.reject(mint, "UNPARSEABLE_MINT");
        if (info.mintAuthority !== null) return this.reject(mint, "ACTIVE_MINT_AUTHORITY");
        if (info.freezeAuthority !== null) return this.reject(mint, "ACTIVE_FREEZE_AUTHORITY");
        const unknown = (info.extensions ?? []).find((extension) => !ALLOWED_EXTENSIONS.has(extension.extension));
        if (unknown) return this.reject(mint, `UNREVIEWED_EXTENSION_${unknown.extension}`);
        return "ok";
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    // Unknown remains unknown. The trader keeps the candidate blocked.
    return undefined;
  }

  private reject(mint: string, reason: string): AuthorityStatus {
    this.reasons.set(mint, reason);
    return "reject";
  }

  private persist(): void {
    if (!this.cachePath) return;
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(Object.fromEntries(this.cache)));
  }
}
