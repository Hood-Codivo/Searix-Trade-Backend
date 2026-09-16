import { createHash } from 'node:crypto';
import type { FeePolicy } from './fee-policy.js';
import { fetchJupiterSwapQuote } from '../providers/jupiter-swap-quote.js';

export type QualityTone = 'clean' | 'watch' | 'caution';

export type CandleRange = '1h' | '1d' | '1w' | '1m';

export const CANDLE_RANGE_MS: Record<CandleRange, number> = {
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1m': 30 * 24 * 60 * 60_000,
};

export type OrderLevel = {
  price: number;
  size: number;
};

export type MarketSnapshot = {
  id: string;
  base: string;
  quote: string;
  venue: 'Phoenix';
  price: number;
  change24h: number;
  volume24h: number;
  spreadBps: number;
  depthUsd: number;
  imbalance: number;
  quality: {
    label: string;
    tone: QualityTone;
    summary: string;
    score: number;
  };
  bids: OrderLevel[];
  asks: OrderLevel[];
  candles: number[];
  sequence: number;
  observedAt: string;
  assetClass?: 'crypto' | 'tokenized-stock';
  underlyingSymbol?: string;
  // Real mint/decimals, when the provider knows them -- lets calculateExecutionQuote fetch a real
  // Jupiter swap-quote comparison instead of a fabricated one.
  baseMint?: string;
  quoteMint?: string;
  baseDecimals?: number;
  quoteDecimals?: number;
  reference?: {
    source: 'Jupiter';
    underlyingFeed: string;
    tokenFeed: string;
    underlyingPrice: number;
    tokenPrice: number;
    premiumBps: number;
    marketState: 'open' | 'closed';
    isLive: boolean;
    observedAt: string;
  };
};

export type TradeSide = 'buy' | 'sell';

export type ExecutionQuote = {
  marketId: string;
  side: TradeSide;
  requestedUsd: number;
  filledUsd: number;
  fillPercent: number;
  averagePrice: number;
  referencePrice: number;
  priceImpactBps: number;
  spreadBps: number;
  feeUsd: number;
  feeBreakdown: {
    venueFeeUsd: number;
    phoenixFeeUsd: number;
    phoenixFeeBps: number;
    collectionEnabled: boolean;
    status: 'preview' | 'collectible';
  };
  totalUsd: number;
  levelsConsumed: number;
  safeSizeUsd: number;
  qualityScore: number;
  qualityLabel: 'Efficient' | 'Acceptable' | 'Expensive';
  warning: string | null;
  explanation: string;
  observedAt: string;
  venueQuotes: Array<{
    venue: 'Phoenix' | 'Jupiter';
    averagePrice: number;
    priceImpactBps: number;
    estimatedTotalUsd: number;
    best: boolean;
    isLive: boolean;
  }>;
};

export type ExecutionReceipt = {
  id: string;
  createdAt: string;
  marketId: string;
  symbol: string;
  side: TradeSide;
  requestedUsd: number;
  expectedAveragePrice: number;
  expectedImpactBps: number;
  qualityScore: number;
  bestVenue: string;
  benchmarkPrice: number | null;
  premiumBps: number | null;
  verified: false;
  transactionSignature: null;
  status: 'analysis';
  phoenixFeeUsd: number;
  phoenixFeeBps: number;
  feeStatus: 'projected' | 'collected';
  // SHA-256 over the receipt's evidentiary fields (everything but id/contentHash itself), so anyone
  // holding the receipt can prove it wasn't altered after the fact — independent of tx verification.
  contentHash: string;
};

export function calculateSpreadBps(bestBid: number, bestAsk: number) {
  const mid = (bestBid + bestAsk) / 2;
  return mid === 0 ? 0 : ((bestAsk - bestBid) / mid) * 10_000;
}

export function calculateImbalance(bids: OrderLevel[], asks: OrderLevel[]) {
  const bidSize = bids.reduce((sum, level) => sum + level.size, 0);
  const askSize = asks.reduce((sum, level) => sum + level.size, 0);
  const total = bidSize + askSize;
  return total === 0 ? 0.5 : bidSize / total;
}

export function scoreMarket(spreadBps: number, depthUsd: number, imbalance: number) {
  const spreadScore = Math.max(0, 45 - spreadBps * 2.2);
  const depthScore = Math.min(35, Math.log10(Math.max(1, depthUsd)) * 6);
  const balanceScore = Math.max(0, 20 - Math.abs(imbalance - 0.5) * 55);
  const score = Math.round(Math.min(100, spreadScore + depthScore + balanceScore));
  if (score >= 82) return { score, label: 'Clean fills', tone: 'clean' as const };
  if (score >= 65) return { score, label: 'Watch depth', tone: 'watch' as const };
  return { score, label: 'Use caution', tone: 'caution' as const };
}

export function summarizeQuality(tone: QualityTone): string {
  if (tone === 'clean') return 'Tight spread and healthy visible depth on both sides of the book.';
  if (tone === 'watch') return 'Spread and depth are moderate; larger orders may see more slippage.';
  return 'Wide spread or thin depth on this book may cause higher slippage.';
}

const round = (value: number, places = 2) => Number(value.toFixed(places));

// Fetches a real Jupiter-routed price for the same trade, in the same units as the Phoenix-side
// math above (quote-currency per base unit), so the two rows are genuinely comparable. Returns
// null on any failure -- callers show a single real Phoenix row rather than a fabricated one.
async function fetchRealJupiterComparison(
  market: MarketSnapshot,
  side: TradeSide,
  requestedUsd: number,
  requestedBase: number,
  referencePrice: number,
): Promise<ExecutionQuote['venueQuotes'][number] | null> {
  if (!market.baseMint || !market.quoteMint || market.baseDecimals === undefined || market.quoteDecimals === undefined) return null;

  if (side === 'buy') {
    const inputAtoms = BigInt(Math.round(requestedUsd * 10 ** market.quoteDecimals));
    if (inputAtoms <= 0n) return null;
    const quote = await fetchJupiterSwapQuote(market.quoteMint, market.baseMint, inputAtoms.toString());
    if (!quote) return null;
    const outBase = quote.outAmount / 10 ** market.baseDecimals;
    if (outBase <= 0) return null;
    const averagePrice = requestedUsd / outBase;
    const priceImpactBps = Math.max(0, ((averagePrice - referencePrice) / referencePrice) * 10_000);
    return { venue: 'Jupiter', averagePrice: round(averagePrice, 10), priceImpactBps: round(priceImpactBps, 1), estimatedTotalUsd: round(requestedUsd), best: false, isLive: true };
  }

  const inputAtoms = BigInt(Math.round(requestedBase * 10 ** market.baseDecimals));
  if (inputAtoms <= 0n) return null;
  const quote = await fetchJupiterSwapQuote(market.baseMint, market.quoteMint, inputAtoms.toString());
  if (!quote) return null;
  const outUsd = quote.outAmount / 10 ** market.quoteDecimals;
  if (outUsd <= 0 || requestedBase <= 0) return null;
  const averagePrice = outUsd / requestedBase;
  const priceImpactBps = Math.max(0, ((referencePrice - averagePrice) / referencePrice) * 10_000);
  return { venue: 'Jupiter', averagePrice: round(averagePrice, 10), priceImpactBps: round(priceImpactBps, 1), estimatedTotalUsd: round(outUsd), best: false, isLive: true };
}

export async function calculateExecutionQuote(market: MarketSnapshot, side: TradeSide, requestedUsd: number, feePolicy: FeePolicy): Promise<ExecutionQuote> {
  const levels = side === 'buy' ? market.asks : market.bids;
  const referencePrice = side === 'buy' ? market.asks[0]?.price : market.bids[0]?.price;
  if (!referencePrice || levels.length === 0) throw new Error('ORDER_BOOK_EMPTY');

  const requestedBase = requestedUsd / referencePrice;
  let remainingBase = requestedBase;
  let filledBase = 0;
  let filledNotional = 0;
  let levelsConsumed = 0;

  for (const level of levels) {
    if (remainingBase <= 0) break;
    const fillBase = Math.min(remainingBase, level.size);
    if (fillBase <= 0) continue;
    filledBase += fillBase;
    filledNotional += fillBase * level.price;
    remainingBase -= fillBase;
    levelsConsumed += 1;
  }

  const averagePrice = filledBase > 0 ? filledNotional / filledBase : referencePrice;
  const directionalImpact = side === 'buy'
    ? (averagePrice - referencePrice) / referencePrice
    : (referencePrice - averagePrice) / referencePrice;
  const priceImpactBps = Math.max(0, directionalImpact * 10_000);
  const filledUsd = filledNotional;
  const fillPercent = requestedBase > 0 ? Math.min(100, (filledBase / requestedBase) * 100) : 0;
  const venueFeeBps = 2;
  const feeUsd = filledUsd * venueFeeBps / 10_000;
  const phoenixFeeUsd = filledUsd * feePolicy.standardFeeBps / 10_000;

  let safeSizeUsd = 0;
  for (const level of levels) {
    const levelImpact = side === 'buy'
      ? (level.price - referencePrice) / referencePrice
      : (referencePrice - level.price) / referencePrice;
    if (levelImpact * 10_000 > 25) break;
    safeSizeUsd += level.size * level.price;
  }

  const qualityScore = Math.max(0, Math.round(100 - priceImpactBps * 1.4 - market.spreadBps * 0.8 - (100 - fillPercent)));
  const qualityLabel = qualityScore >= 85 ? 'Efficient' : qualityScore >= 65 ? 'Acceptable' : 'Expensive';
  const warning = fillPercent < 99.9
    ? `Only ${round(fillPercent, 1)}% of this order is visible in the current book.`
    : priceImpactBps > 25
      ? `This order exceeds the 25 bps liquidity budget by ${round(priceImpactBps - 25, 1)} bps.`
      : null;
  const explanation = `${side === 'buy' ? 'Buying' : 'Selling'} $${round(requestedUsd).toLocaleString('en-US')} is estimated to cross ${levelsConsumed} ${levelsConsumed === 1 ? 'level' : 'levels'} and move the fill ${round(priceImpactBps, 1)} bps from the best available price.`;

  const combinedFees = feeUsd + (feePolicy.enabled ? phoenixFeeUsd : 0);
  const phoenixTotal = side === 'buy' ? filledUsd + combinedFees : filledUsd - combinedFees;

  const venueQuotes: ExecutionQuote['venueQuotes'] = [
    { venue: 'Phoenix', averagePrice: round(averagePrice, 10), priceImpactBps: round(priceImpactBps, 1), estimatedTotalUsd: round(phoenixTotal), best: true, isLive: true },
  ];
  const jupiterRow = await fetchRealJupiterComparison(market, side, requestedUsd, requestedBase, referencePrice);
  if (jupiterRow) venueQuotes.push(jupiterRow);

  // Best = whichever real row gives the better price (lower per-unit cost on a buy, higher
  // proceeds on a sell). Compares averagePrice, not estimatedTotalUsd -- the latter bakes in our
  // own platform fee for the Phoenix row but not Jupiter's, so it isn't a fair comparison.
  const bestRow = venueQuotes.reduce((best, row) => {
    const better = side === 'buy' ? row.averagePrice < best.averagePrice : row.averagePrice > best.averagePrice;
    return better ? row : best;
  });
  for (const row of venueQuotes) row.best = row === bestRow;

  return {
    marketId: market.id,
    side,
    requestedUsd: round(requestedUsd),
    filledUsd: round(filledUsd),
    fillPercent: round(fillPercent, 1),
    averagePrice: round(averagePrice, 10),
    referencePrice: round(referencePrice, 10),
    priceImpactBps: round(priceImpactBps, 1),
    spreadBps: round(market.spreadBps, 1),
    feeUsd: round(feeUsd),
    feeBreakdown: {
      venueFeeUsd: round(feeUsd),
      phoenixFeeUsd: round(phoenixFeeUsd),
      phoenixFeeBps: feePolicy.standardFeeBps,
      collectionEnabled: feePolicy.enabled,
      status: feePolicy.enabled ? 'collectible' : 'preview',
    },
    totalUsd: round(phoenixTotal),
    levelsConsumed,
    safeSizeUsd: round(safeSizeUsd),
    qualityScore,
    qualityLabel,
    warning,
    explanation,
    observedAt: market.observedAt,
    venueQuotes,
  };
}

export function createExecutionReceipt(market: MarketSnapshot, quote: ExecutionQuote): ExecutionReceipt {
  const bestVenue = quote.venueQuotes.find((venue) => venue.best)?.venue ?? market.venue;
  const evidence = {
    createdAt: new Date().toISOString(),
    marketId: market.id,
    symbol: market.base,
    side: quote.side,
    requestedUsd: quote.requestedUsd,
    expectedAveragePrice: quote.averagePrice,
    expectedImpactBps: quote.priceImpactBps,
    qualityScore: quote.qualityScore,
    bestVenue,
    benchmarkPrice: market.reference?.underlyingPrice ?? null,
    premiumBps: market.reference?.premiumBps ?? null,
    phoenixFeeUsd: quote.feeBreakdown.phoenixFeeUsd,
    phoenixFeeBps: quote.feeBreakdown.phoenixFeeBps,
  };
  const contentHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');

  return {
    id: `pxr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ...evidence,
    verified: false,
    transactionSignature: null,
    status: 'analysis',
    feeStatus: 'projected',
    contentHash,
  };
}
