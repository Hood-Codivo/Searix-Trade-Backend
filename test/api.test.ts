import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import type { MarketSnapshot } from '../src/domain/market.js';
import type { MarketProvider, MarketUpdate } from '../src/providers/market-provider.js';

const fixtures: MarketSnapshot[] = [
  { id: 'sol-usdc', base: 'SOL', quote: 'USDC', venue: 'Phoenix', price: 192.51, change24h: 0.52,
    volume24h: 18_400_000, spreadBps: 1.8, depthUsd: 842_000, imbalance: 0.58,
    quality: { label: 'Clean fills', tone: 'clean', score: 92, summary: 'Tight spread and balanced depth.' },
    bids: [{ price: 192.49, size: 92 }], asks: [{ price: 192.53, size: 84 }],
    candles: [190, 191, 192.51], sequence: 1, observedAt: new Date().toISOString() },
  { id: 'jup-usdc', base: 'JUP', quote: 'USDC', venue: 'Phoenix', price: 0.9421, change24h: -1.24,
    volume24h: 5_210_000, spreadBps: 4.7, depthUsd: 294_000, imbalance: 0.43,
    quality: { label: 'Watch depth', tone: 'watch', score: 74, summary: 'Depth thins for larger orders.' },
    bids: [{ price: 0.9418, size: 18_000 }], asks: [{ price: 0.9424, size: 21_000 }],
    candles: [0.95, 0.94, 0.9421], sequence: 1, observedAt: new Date().toISOString() },
  { id: 'bonk-usdc', base: 'BONK', quote: 'USDC', venue: 'Phoenix', price: 0.00002148, change24h: 3.81,
    volume24h: 2_860_000, spreadBps: 11.6, depthUsd: 91_000, imbalance: 0.69,
    quality: { label: 'Use caution', tone: 'caution', score: 48, summary: 'Wide spread, higher slippage risk.' },
    bids: [{ price: 0.00002142, size: 1.2e9 }], asks: [{ price: 0.00002154, size: 0.8e9 }],
    candles: [0.0000210, 0.0000213, 0.00002148], sequence: 1, observedAt: new Date().toISOString() },
  { id: 'pyth-usdc', base: 'PYTH', quote: 'USDC', venue: 'Phoenix', price: 0.3842, change24h: 1.06,
    volume24h: 1_740_000, spreadBps: 5.2, depthUsd: 176_000, imbalance: 0.51,
    quality: { label: 'Clean fills', tone: 'clean', score: 84, summary: 'Balanced depth, fills near quote.' },
    bids: [{ price: 0.384, size: 28_000 }], asks: [{ price: 0.3844, size: 26_000 }],
    candles: [0.38, 0.383, 0.3842], sequence: 1, observedAt: new Date().toISOString() },
];

// Static, offline fixture provider so the API-contract tests don't depend on live Solana RPC.
class FixtureMarketProvider implements MarketProvider {
  status: 'idle' | 'connected' | 'degraded' = 'idle';
  async start() { this.status = 'connected'; }
  async stop() { this.status = 'idle'; }
  list() { return fixtures.map((market) => structuredClone(market)); }
  get(id: string) { const market = fixtures.find((m) => m.id === id); return market ? structuredClone(market) : undefined; }
  subscribe(_listener: (event: MarketUpdate) => void) { return () => {}; }
}

let app: FastifyInstance;

before(async () => { app = await createApp(new FixtureMarketProvider()); });
after(async () => { await app.close(); });

describe('market API', () => {
  it('reports provider health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().provider, 'connected');
  });

  it('lists normalized markets', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/markets' });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 4);
    assert.equal(body.data[0].venue, 'Phoenix');
    assert.ok(body.data[0].sequence > 0);
  });

  it('returns market depth and quality', async () => {
    const [book, quality] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/markets/sol-usdc/orderbook' }),
      app.inject({ method: 'GET', url: '/v1/markets/sol-usdc/quality' }),
    ]);
    assert.equal(book.statusCode, 200);
    assert.ok(book.json().data.bids.length > 0);
    assert.equal(quality.statusCode, 200);
    assert.match(quality.json().data.modelVersion, /preview/);
  });

  it('returns a stable 404 error contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/markets/missing' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'MARKET_NOT_FOUND');
  });
});
