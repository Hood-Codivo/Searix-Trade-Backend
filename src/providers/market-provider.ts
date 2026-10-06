import type { PublicKey } from '@solana/web3.js';
import type { CandleRange, MarketSnapshot, TradeSide } from '../domain/market.js';
import type { BuiltSwapTransaction } from './jupiter-swap-builder.js';

export type MarketUpdate = {
  type: 'market.update';
  market: MarketSnapshot;
};

// Platform fee collected as a plain SPL transfer appended to a venue swap. The treasury's associated
// token account for the input mint is created idempotently in the same transaction, paid by the trader.
export type SwapFeeTransfer = {
  mint: string;
  decimals: number;
  amountAtoms: bigint;
  owner: string;
  destinationAccount: string;
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
  /**
   * Builds an unsigned swap transaction for this venue's own order book, or null when the provider
   * has no live venue for the market. Only providers with a real on-chain book implement this.
   */
  buildSwapTransaction?(id: string, side: TradeSide, inAmount: number, trader: PublicKey, fee?: SwapFeeTransfer): Promise<BuiltSwapTransaction | null>;
}
