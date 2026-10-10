import { DEFAULT_RPC_WS_URLS } from "./stream.js";

const PUBLIC_HTTP_RPC = "https://api.mainnet-beta.solana.com";

/** Removes API keys from an endpoint URL so it is safe to log. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.search || parsed.pathname.length > 1 ? "/<redacted>" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

/**
 * Resolves read-only RPC endpoints. SOLANA_RPC_PROVIDER_KEY may hold a full
 * provider URL (for example a Helius URL with an api-key query). The provider
 * is added to the free public endpoints, so one failure does not stop the feed.
 */
export function resolveEndpoints(env: NodeJS.ProcessEnv = process.env): { wsUrls: string[]; httpUrl: string } {
  const provider = env.SOLANA_RPC_PROVIDER_KEY?.trim();
  const providerHttp = provider && /^https?:\/\//.test(provider) ? provider : undefined;
  const providerWs = providerHttp?.replace(/^http/, "ws");
  const explicitWs = env.SOLANA_WS_URLS?.split(",").map((url) => url.trim()).filter(Boolean);
  const wsUrls = explicitWs && explicitWs.length > 0 ? explicitWs : [...(providerWs ? [providerWs] : []), ...DEFAULT_RPC_WS_URLS];
  return { wsUrls, httpUrl: env.SOLANA_RPC_URL ?? providerHttp ?? PUBLIC_HTTP_RPC };
}
