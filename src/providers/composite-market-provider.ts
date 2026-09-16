import type { CandleRange, MarketSnapshot } from '../domain/market.js';
import type { MarketProvider, MarketUpdate } from './market-provider.js';

// Fans a single MarketProvider surface out over several underlying providers (e.g. live Phoenix
// crypto markets + simulated tokenized-stock markets) with no ID collisions to worry about — real
// Phoenix market ids are full base58 pubkeys, the stock provider uses `<ticker>-usdc` slugs.
export class CompositeMarketProvider implements MarketProvider {
  constructor(private readonly providers: MarketProvider[]) {}

  get status(): 'idle' | 'connected' | 'degraded' {
    const statuses = this.providers.map((provider) => provider.status);
    if (statuses.includes('degraded')) return 'degraded';
    if (statuses.some((status) => status === 'connected')) return 'connected';
    return 'idle';
  }

  async start() {
    await Promise.all(this.providers.map((provider) => provider.start()));
  }

  async stop() {
    await Promise.all(this.providers.map((provider) => provider.stop()));
  }

  list(): MarketSnapshot[] {
    return this.providers.flatMap((provider) => provider.list());
  }

  get(id: string): MarketSnapshot | undefined {
    for (const provider of this.providers) {
      const market = provider.get(id);
      if (market) return market;
    }
    return undefined;
  }

  subscribe(listener: (event: MarketUpdate) => void) {
    const unsubscribers = this.providers.map((provider) => provider.subscribe(listener));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }

  getCandles(id: string, range: CandleRange): number[] | undefined {
    for (const provider of this.providers) {
      if (provider.get(id)) return provider.getCandles?.(id, range);
    }
    return undefined;
  }
}
