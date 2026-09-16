import { Client, type MarketState } from '@ellipsis-labs/phoenix-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { calculateImbalance, calculateSpreadBps, scoreMarket, type MarketSnapshot, type OrderLevel } from '../domain/market.js';
import type { MarketProvider, MarketUpdate } from './market-provider.js';

// Only the mints we can label with confidence; anything else falls back to a shortened address
// rather than guessing a ticker symbol.
const KNOWN_MINT_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

function symbolForMint(mint: PublicKey): string {
  const key = mint.toBase58();
  return KNOWN_MINT_SYMBOLS[key] ?? `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function summarizeQuality(tone: 'clean' | 'watch' | 'caution'): string {
  if (tone === 'clean') return 'Tight spread and healthy visible depth on both sides of the book.';
  if (tone === 'watch') return 'Spread and depth are moderate; larger orders may see more slippage.';
  return 'Wide spread or thin depth on this book may cause higher slippage.';
}

export type PhoenixProviderConfig = {
  rpcUrl: string;
  wsUrl?: string;
  marketAddresses: string[];
  pollMs?: number;
};

export class PhoenixProvider implements MarketProvider {
  private readonly connection: Connection;
  private client?: Client;
  private readonly markets = new Map<string, MarketSnapshot>();
  private readonly listeners = new Set<(event: MarketUpdate) => void>();
  private readonly subscriptionIds: number[] = [];
  private pollTimer?: NodeJS.Timeout;
  status: 'idle' | 'connected' | 'degraded' = 'idle';

  constructor(private readonly config: PhoenixProviderConfig) {
    this.connection = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: config.wsUrl });
  }

  async start() {
    const marketPubkeys = this.config.marketAddresses.map((address) => new PublicKey(address));
    this.client = await Client.createWithMarketAddresses(this.connection, marketPubkeys);

    for (const address of this.config.marketAddresses) {
      this.applySnapshot(address);
      const pubkey = new PublicKey(address);
      const subscriptionId = this.connection.onAccountChange(
        pubkey,
        (accountInfo) => {
          const marketState = this.client?.marketStates.get(address);
          if (!marketState) return;
          marketState.reload(accountInfo.data);
          this.applySnapshot(address);
        },
        { commitment: 'confirmed' },
      );
      this.subscriptionIds.push(subscriptionId);
    }

    this.status = 'connected';
    // Backstop in case a websocket update is silently dropped; keeps `status` honest even then.
    this.pollTimer = setInterval(() => this.pollAll(), this.config.pollMs ?? 15_000);
  }

  async stop() {
    for (const id of this.subscriptionIds) await this.connection.removeAccountChangeListener(id);
    this.subscriptionIds.length = 0;
    if (this.pollTimer) clearInterval(this.pollTimer);
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

  private async pollAll() {
    if (!this.client) return;
    try {
      await this.client.refreshAllMarkets();
      for (const address of this.config.marketAddresses) this.applySnapshot(address);
      this.status = 'connected';
    } catch {
      this.status = 'degraded';
    }
  }

  private applySnapshot(address: string) {
    const client = this.client;
    const marketState: MarketState | undefined = client?.marketStates.get(address);
    if (!client || !marketState) return;

    const ladder = client.getUiLadder(address, 8);
    const bids: OrderLevel[] = ladder.bids.map((level) => ({ price: level.price, size: level.quantity }));
    const asks: OrderLevel[] = ladder.asks.map((level) => ({ price: level.price, size: level.quantity }));
    if (bids.length === 0 && asks.length === 0) return;

    const bestBid = bids[0]?.price ?? asks[0].price;
    const bestAsk = asks[0]?.price ?? bids[0].price;
    const price = (bestBid + bestAsk) / 2;
    const spreadBps = calculateSpreadBps(bestBid, bestAsk);
    const imbalance = calculateImbalance(bids, asks);
    const depthUsd = [...bids, ...asks].reduce((sum, level) => sum + level.price * level.size, 0);
    const { score, label, tone } = scoreMarket(spreadBps, depthUsd, imbalance);

    const header = marketState.data.header;
    const base = symbolForMint(header.baseParams.mintKey);
    const quote = symbolForMint(header.quoteParams.mintKey);

    const previous = this.markets.get(address);
    // No historical fills/candles feed exists yet (see README), so this is a live-only rolling
    // window built from observed prices this session, not a true 24h series. change24h is
    // reported against the first price seen this run for the same reason.
    const firstPrice = previous?.candles[0] ?? price;
    const candles = previous ? [...previous.candles.slice(-19), price] : [price];
    const change24h = firstPrice === 0 ? 0 : ((price - firstPrice) / firstPrice) * 100;

    const snapshot: MarketSnapshot = {
      id: address,
      base,
      quote,
      venue: 'Phoenix',
      price,
      change24h,
      volume24h: 0, // requires a fills/trade-history feed, which is not built yet (README)
      spreadBps,
      depthUsd,
      imbalance,
      quality: { score, label, tone, summary: summarizeQuality(tone) },
      bids,
      asks,
      candles,
      sequence: marketState.getMarketSequenceNumber(),
      observedAt: new Date().toISOString(),
    };

    this.markets.set(address, snapshot);
    const event: MarketUpdate = { type: 'market.update', market: structuredClone(snapshot) };
    for (const listener of this.listeners) listener(event);
  }
}
