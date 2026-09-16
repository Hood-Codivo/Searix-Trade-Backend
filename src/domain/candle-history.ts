import { CANDLE_RANGE_MS, type CandleRange } from './market.js';

export type PricePoint = { ts: number; price: number };

const MAX_HISTORY_MS = CANDLE_RANGE_MS['1m'];
const MAX_CANDLE_POINTS = 60;

function downsample(points: PricePoint[], maxPoints: number): PricePoint[] {
  if (points.length <= maxPoints) return points;
  const bucketSize = points.length / maxPoints;
  const buckets: PricePoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    const bucket = points.slice(start, end);
    const avgPrice = bucket.reduce((sum, point) => sum + point.price, 0) / bucket.length;
    buckets.push({ ts: bucket[bucket.length - 1].ts, price: avgPrice });
  }
  return buckets;
}

// Shared by every MarketProvider that needs range-aware candles: records real observed prices
// per market id and serves a downsampled slice for a requested range. Used by both PhoenixProvider
// (live on-chain ticks) and TokenizedStockProvider (real Jupiter-sourced ticks) so neither duplicates it.
export class CandleHistory {
  private readonly byId = new Map<string, PricePoint[]>();

  record(id: string, price: number, ts = Date.now()) {
    const history = this.byId.get(id) ?? [];
    history.push({ ts, price });
    const cutoff = ts - MAX_HISTORY_MS;
    while (history.length > 0 && history[0].ts < cutoff) history.shift();
    this.byId.set(id, history);
  }

  getCandles(id: string, range: CandleRange): number[] | undefined {
    const history = this.byId.get(id);
    if (!history || history.length === 0) return undefined;
    const cutoff = Date.now() - CANDLE_RANGE_MS[range];
    const inWindow = history.filter((point) => point.ts >= cutoff);
    if (inWindow.length === 0) return [];
    return downsample(inWindow, MAX_CANDLE_POINTS).map((point) => point.price);
  }
}
