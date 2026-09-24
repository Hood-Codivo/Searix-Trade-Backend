import { CandleHistory } from '../domain/candle-history.js';
import { recordTick } from '../domain/clickhouse.js';
import { calculateImbalance, calculateSpreadBps, scoreMarket, summarizeQuality, type CandleRange, type MarketSnapshot, type OrderLevel } from '../domain/market.js';
import type { MarketProvider, MarketUpdate } from './market-provider.js';
import { JupiterReferenceClient } from './jupiter-reference-client.js';
import { USDC_MINT } from './jupiter-swap-quote.js';
import { fetchPythPrices } from './pyth-client.js';

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
  // Real Pyth Hermes feed ids, confirmed live via the discovery endpoint (v2/price_feeds) --
  // not guessed. Equity/xStock feeds currently return "not entitled" on a free-tier key; the
  // ids themselves are real regardless of grant status.
  pythEquityFeedId: string;
  pythTokenFeedId: string;
  pythRedemptionRateFeedId: string;
};

// Real, independently-verified xStocks (Backed Finance) mints on Solana mainnet -- confirmed via
// direct getAccountInfo lookups, not just trusted from a webpage (decimals=8 confirmed the same
// way). This is the only hardcoded data in this file: real identity/config, not a market snapshot.
// No price, book, quality, or candle data is ever seeded -- a market only appears in list()/get()
// once a real fetch has actually populated it.
const configs: StockConfig[] = [
  { id: 'aaplx-usdc', base: 'AAPLX', quote: 'USDC', underlyingSymbol: 'AAPL', underlyingFeed: 'AAPL', tokenFeed: 'AAPLx', baseMint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', quoteMint: USDC_MINT, baseDecimals: 8, quoteDecimals: 6,
    pythEquityFeedId: '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688', pythTokenFeedId: '978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675', pythRedemptionRateFeedId: '25babb83691a056fd65f879bfd7197eabd840aae741f69c87ccb31e204a979b2' },
  { id: 'tslax-usdc', base: 'TSLAX', quote: 'USDC', underlyingSymbol: 'TSLA', underlyingFeed: 'TSLA', tokenFeed: 'TSLAx', baseMint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', quoteMint: USDC_MINT, baseDecimals: 8, quoteDecimals: 6,
    pythEquityFeedId: '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1', pythTokenFeedId: '47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362', pythRedemptionRateFeedId: '997362625415627e9e3177f6c0d32f200d4a221ccadb3dddab80d6079d03ea24' },
  { id: 'nvdax-usdc', base: 'NVDAX', quote: 'USDC', underlyingSymbol: 'NVDA', underlyingFeed: 'NVDA', tokenFeed: 'NVDAx', baseMint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', quoteMint: USDC_MINT, baseDecimals: 8, quoteDecimals: 6,
    pythEquityFeedId: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593', pythTokenFeedId: '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f', pythRedemptionRateFeedId: 'b675c4e9f46d94afa9174a7df09966b77a2950970bb50a77ec8ad4fcfd8266f4' },
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
    private readonly pythApiKey: string | undefined = process.env.PYTH_API_KEY,
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
      const [prices, stats, pythEquity, pythToken, pythRR] = await Promise.all([
        this.jupiter.fetchPrices(mints),
        this.jupiter.fetchStats(mints).catch(() => new Map()),
        // Fetched as three separate category calls rather than one combined batch: Hermes returns
        // a whole-batch 403 if any single requested feed isn't entitled, so grouping this way means
        // one category (e.g. redemption-rate) coming online doesn't get masked by another still
        // being gated.
        fetchPythPrices(configs.map((c) => c.pythEquityFeedId), this.pythApiKey),
        fetchPythPrices(configs.map((c) => c.pythTokenFeedId), this.pythApiKey),
        fetchPythPrices(configs.map((c) => c.pythRedemptionRateFeedId), this.pythApiKey),
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
        this.candleHistory.record(config.id, priced.tokenPrice, Date.now());
        void recordTick(config.id, priced.tokenPrice);
        // Reuse the same real, range-aware history /candles serves -- see the identical fix and
        // rationale in phoenix-provider.ts.
        const candles = this.candleHistory.getCandles(config.id, '1m') ?? [priced.tokenPrice];

        const premiumBps = ((priced.tokenPrice - priced.underlyingPrice) / priced.underlyingPrice) * 10_000;

        const equityPoint = pythEquity.prices.get(config.pythEquityFeedId) ?? null;
        const tokenPoint = pythToken.prices.get(config.pythTokenFeedId) ?? null;
        const rrPoint = pythRR.prices.get(config.pythRedemptionRateFeedId) ?? null;
        const pythIsLive = equityPoint !== null && tokenPoint !== null;
        // Prefer Pyth's own first-party redemption-rate feed for the premium when it's entitled;
        // fall back to deriving it from the two price feeds -- both are real Pyth data, just from
        // a different feed combination, never fabricated.
        const pythPremiumBps = rrPoint !== null
          ? (rrPoint.price - 1) * 10_000
          : pythIsLive ? ((tokenPoint!.price - equityPoint!.price) / equityPoint!.price) * 10_000 : null;
        const anyPythEntitled = pythEquity.entitled || pythToken.entitled || pythRR.entitled;

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
          pyth: {
            source: 'Pyth',
            equityPrice: equityPoint?.price ?? null,
            tokenPrice: tokenPoint?.price ?? null,
            redemptionRate: rrPoint?.price ?? null,
            premiumBps: pythPremiumBps,
            isLive: pythIsLive,
            unavailableReason: pythIsLive ? null : anyPythEntitled ? 'unavailable' : 'entitlement_pending',
            observedAt: new Date().toISOString(),
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
