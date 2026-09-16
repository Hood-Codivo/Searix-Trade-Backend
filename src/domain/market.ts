export type QualityTone = 'clean' | 'watch' | 'caution';

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
