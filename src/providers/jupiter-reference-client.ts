// Free, keyless price source for the real tokenized-stock markets: Jupiter's Price API returns
// both the real on-chain token price (aggregated across Raydium/Jupiter liquidity) and, for
// Backed Finance's "xStocks" specifically, a `stockData.price` field carrying the real underlying
// equity reference price. Verified directly (curl) before wiring this in -- no API key required.
const PRICE_URL = 'https://lite-api.jup.ag/price/v3';
// The token search endpoint returns a superset of stats price/v3 lacks (real 24h buy+sell volume,
// real liquidity, real 24h price change) -- verified live before wiring in. It also accepts
// comma-separated mint addresses directly as the query, so one batched call covers every market.
const SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search';

type JupiterPriceEntry = {
  usdPrice: number;
  stockData?: { price: number; updatedAt: string };
};

type JupiterPriceResponse = Record<string, JupiterPriceEntry>;

export type ReferencePrice = {
  tokenPrice: number;
  underlyingPrice: number | null;
  observedAt: string;
};

type JupiterSearchEntry = {
  id: string;
  liquidity?: number;
  stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number };
};

export type MarketStats = {
  change24h: number;
  volume24h: number;
  liquidity: number;
};

export class JupiterReferenceClient {
  async fetchPrices(mints: string[]): Promise<Map<string, ReferencePrice>> {
    const response = await fetch(`${PRICE_URL}?ids=${encodeURIComponent(mints.join(','))}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`JUPITER_HTTP_${response.status}`);
    const payload = await response.json() as JupiterPriceResponse;

    const result = new Map<string, ReferencePrice>();
    for (const mint of mints) {
      const entry = payload[mint];
      if (!entry || !Number.isFinite(entry.usdPrice)) continue;
      result.set(mint, {
        tokenPrice: entry.usdPrice,
        underlyingPrice: entry.stockData?.price ?? null,
        observedAt: entry.stockData?.updatedAt ?? new Date().toISOString(),
      });
    }
    return result;
  }

  async fetchStats(mints: string[]): Promise<Map<string, MarketStats>> {
    if (mints.length === 0) return new Map();
    const response = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(mints.join(','))}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`JUPITER_HTTP_${response.status}`);
    const payload = await response.json() as JupiterSearchEntry[];

    const result = new Map<string, MarketStats>();
    for (const entry of payload) {
      const stats = entry.stats24h;
      result.set(entry.id, {
        change24h: stats?.priceChange ?? 0,
        volume24h: (stats?.buyVolume ?? 0) + (stats?.sellVolume ?? 0),
        liquidity: entry.liquidity ?? 0,
      });
    }
    return result;
  }
}
