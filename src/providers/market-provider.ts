import type { CandleRange, MarketSnapshot } from '../domain/market.js';

export type MarketUpdate = {
  type: 'market.update';
  market: MarketSnapshot;
};

export interface MarketProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  list(): MarketSnapshot[];
  get(id: string): MarketSnapshot | undefined;
  subscribe(listener: (event: MarketUpdate) => void): () => void;
  readonly status: 'idle' | 'connected' | 'degraded';
  /**
   * Returns real observed prices within the given range, oldest first, or undefined if the
   * provider has no range-aware history. Callers should fall back to `market.candles` when absent.
   */
  getCandles?(id: string, range: CandleRange): number[] | undefined;
}
