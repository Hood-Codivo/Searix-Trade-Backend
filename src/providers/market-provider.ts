import type { MarketSnapshot } from '../domain/market.js';

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
}
