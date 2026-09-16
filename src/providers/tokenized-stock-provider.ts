import { CandleHistory } from '../domain/candle-history.js';
import { calculateImbalance, calculateSpreadBps, scoreMarket, summarizeQuality, type CandleRange, type MarketSnapshot, type OrderLevel } from '../domain/market.js';
import type { MarketProvider, MarketUpdate } from './market-provider.js';
import { JupiterReferenceClient } from './jupiter-reference-client.js';
import { USDC_MINT } from './jupiter-swap-quote.js';

type StockConfig = {
  id: string;
  base: string;
  quote: string;
  underlyingSymbol: string;
  underlyingFeed: string;
  tokenFeed: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
};

// Real, independently-verified xStocks (Backed Finance) mints on Solana mainnet -- confirmed via
// direct getAccountInfo lookups, not just trusted from a webpage (decimals=8 confirmed the same
// way). This is the only hardcoded data in this file: real identity/config, not a market snapshot.
// No price, book, quality, or candle data is ever seeded -- a market only appears in list()/get()
// once a real fetch has actually populated it.
const configs: StockConfig[] = [
  { id: 'aaplx-usdc', base: 'AAPLX', quote: 'USDC', underlyingSymbol: 'AAPL', underlyingFeed: 'AAPL', tokenFeed: 'AAPLx', baseMint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', quoteMint: USDC_MINT, baseDecimals: 8, quoteDecimals: 6 },
  { id: 'tslax-usdc', base: 'TSLAX', quote: 'USDC', underlyingSymbol: 'TSLA', underlyingFeed: 'TSLA', tokenFeed: 'TSLAx', baseMint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', quoteMint: USDC_MINT, baseDecimals: 8, quoteDecimals: 6 },
  { id: 'nvdax-usdc', base: 'NVDAX', quote: 'USDC', underlyingSymbol: 'NVDA', underlyingFeed: 'NVDA', tokenFeed: 'NVDAx', baseMint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', quoteMint: USDC_MINT, baseDecimals: 8, quoteDecimals: 6 },
];

// AMMs have no discrete order-book levels to read, real or otherwise -- this distributes real
// total liquidity across a small number of synthetic levels around the real price, purely so
// calculateExecutionQuote has a book to walk. `stepBps` is a structural modeling constant (how far
// apart to space synthetic levels), not a per-market number -- every price and size here is
// derived from the real `price`/`liquidity` arguments, nothing per-symbol is hardcoded.
function buildSyntheticLadder(price: number, liquidity: number, levels = 4): { bids: OrderLevel[]; asks: OrderLevel[] } {
  const stepBps = 15;
  const notionalPerLevel = liquidity / 2 / levels;
  const bids: OrderLevel[] = [];
  const asks: OrderLevel[] = [];
  for (let i = 1; i <= levels; i++) {
    const offset = (i * stepBps) / 10_000;
    const bidPrice = price * (1 - offset);
    const askPrice = price * (1 + offset);
    bids.push({ price: bidPrice, size: notionalPerLevel / bidPrice });
    asks.push({ price: askPrice, size: notionalPerLevel / askPrice });
  }
  return { bids, asks };
}

// Rough US equity market-hours heuristic (9:30am-4pm ET, Mon-Fri). Ignores DST transitions and
// market holidays -- good enough for a "market open/closed" indicator, not authoritative.
function usMarketState(now = new Date()): 'open' | 'closed' {
  const etHour = (now.getUTCHours() - 5 + 24) % 24 + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();
  const isWeekday = day >= 1 && day <= 5;
  return isWeekday && etHour >= 9.5 && etHour < 16 ? 'open' : 'closed';
}

export class TokenizedStockProvider implements MarketProvider {
  private readonly markets = new Map<string, MarketSnapshot>();
  private readonly candleHistory = new CandleHistory();
  private readonly listeners = new Set<(event: MarketUpdate) => void>();
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  status: 'idle' | 'connected' | 'degraded' = 'idle';

  constructor(
    private readonly pollMs = 20_000,
    private readonly enablePolling = true,
    private readonly jupiter: JupiterReferenceClient = new JupiterReferenceClient(),
  ) {}

  async start() {
    await this.refreshPrices();
    if (this.enablePolling) this.timer = setInterval(() => void this.refreshPrices(), this.pollMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.status = 'idle';
  }

  list() {
    return [...this.markets.values()].map((market) => structuredClone(market));
  }

  get(id: string) {
    const market = this.markets.get(id);
    return market ? structuredClone(market) : undefined;
  }

  subscribe(listener: (event: MarketUpdate) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCandles(id: string, range: CandleRange): number[] | undefined {
    return this.candleHistory.getCandles(id, range);
  }

  private async refreshPrices() {
    try {
      const mints = configs.map((config) => config.baseMint);
      const [prices, stats] = await Promise.all([
        this.jupiter.fetchPrices(mints),
        this.jupiter.fetchStats(mints).catch(() => new Map()),
      ]);
      const marketState = usMarketState();
      let anyLive = false;

      for (const config of configs) {
        const priced = prices.get(config.baseMint);
        // Never show a market with an invented reference -- wait for a fetch that has both the
        // real token price and the real underlying price before this market appears at all.
        if (!priced || priced.underlyingPrice === null) continue;
        anyLive = true;

        const stat = stats.get(config.baseMint);
        const liquidity = stat?.liquidity ?? 0;
        const { bids, asks } = buildSyntheticLadder(priced.tokenPrice, liquidity, 4);
        const spreadBps = calculateSpreadBps(bids[0].price, asks[0].price);
        const imbalance = calculateImbalance(bids, asks);
        const depthUsd = liquidity;
        const { score, label, tone } = scoreMarket(spreadBps, depthUsd, imbalance);

        const previous = this.markets.get(config.id);
        const candles = previous ? [...previous.candles.slice(-19), priced.tokenPrice] : [priced.tokenPrice];
        this.candleHistory.record(config.id, priced.tokenPrice, Date.now());

        const premiumBps = ((priced.tokenPrice - priced.underlyingPrice) / priced.underlyingPrice) * 10_000;

        const market: MarketSnapshot = {
          id: config.id,
          base: config.base,
          quote: config.quote,
          venue: 'Phoenix',
          price: priced.tokenPrice,
          change24h: stat?.change24h ?? previous?.change24h ?? 0,
          volume24h: stat?.volume24h ?? previous?.volume24h ?? 0,
          baseMint: config.baseMint,
          quoteMint: config.quoteMint,
          baseDecimals: config.baseDecimals,
          quoteDecimals: config.quoteDecimals,
          spreadBps,
          depthUsd,
          imbalance,
          assetClass: 'tokenized-stock',
          underlyingSymbol: config.underlyingSymbol,
          reference: {
            source: 'Jupiter',
            underlyingFeed: config.underlyingFeed,
            tokenFeed: config.tokenFeed,
            underlyingPrice: priced.underlyingPrice,
            tokenPrice: priced.tokenPrice,
            premiumBps,
            marketState,
            isLive: true,
            observedAt: priced.observedAt,
          },
          quality: { score, label, tone, summary: summarizeQuality(tone) },
          bids,
          asks,
          candles,
          sequence: (this.sequence += 1),
          observedAt: new Date().toISOString(),
        };

        this.markets.set(config.id, market);
        const event: MarketUpdate = { type: 'market.update', market: structuredClone(market) };
        for (const listener of this.listeners) listener(event);
      }

      this.status = anyLive ? 'connected' : 'degraded';
    } catch {
      this.status = 'degraded';
    }
  }
}
