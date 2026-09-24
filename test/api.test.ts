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
  { id: 'aaplx-usdc', base: 'AAPLX', quote: 'USDC', venue: 'Phoenix', price: 236.84, change24h: 0.74,
    volume24h: 2_940_000, spreadBps: 3.8, depthUsd: 418_000, imbalance: 0.54, assetClass: 'tokenized-stock', underlyingSymbol: 'AAPL',
    reference: { source: 'Jupiter', underlyingFeed: 'AAPL', tokenFeed: 'AAPLx', underlyingPrice: 236.21, tokenPrice: 236.84, premiumBps: 26.7, marketState: 'closed', isLive: false, observedAt: new Date().toISOString() },
    quality: { label: 'Clean fills', tone: 'clean', score: 88, summary: 'Balanced token depth with a modest premium to the underlying equity reference.' },
    bids: [{ price: 236.79, size: 74 }, { price: 236.65, size: 138 }], asks: [{ price: 236.89, size: 69 }, { price: 237.04, size: 146 }],
    candles: [235.9, 236.5, 236.84], sequence: 1, observedAt: new Date().toISOString() },
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
    assert.equal(body.data.length, 5);
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

  it('quotes a buy execution against the book', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/markets/sol-usdc/execution-quote', payload: { side: 'buy', amountUsd: 100 } });
    const body = response.json().data;
    assert.equal(response.statusCode, 200);
    assert.equal(body.marketId, 'sol-usdc');
    assert.ok(body.averagePrice >= body.referencePrice);
    assert.ok(body.levelsConsumed >= 1);
    assert.equal(body.feeBreakdown.phoenixFeeBps, 15);
    assert.equal(body.feeBreakdown.collectionEnabled, false);
  });

  it('rejects an execution-quote with an invalid amount', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/markets/sol-usdc/execution-quote', payload: { side: 'buy', amountUsd: 0 } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_EXECUTION_REQUEST');
  });

  it('saves and lists an execution receipt with a benchmark price for a tokenized-stock market', async () => {
    const saveResponse = await app.inject({ method: 'POST', url: '/v1/markets/aaplx-usdc/execution-receipts', payload: { side: 'buy', amountUsd: 5_000 } });
    const saved = saveResponse.json().data;
    assert.equal(saveResponse.statusCode, 201);
    assert.equal(saved.verified, false);
    assert.equal(saved.symbol, 'AAPLX');
    assert.ok(saved.benchmarkPrice > 0);
    assert.ok(typeof saved.contentHash === 'string' && saved.contentHash.length === 64);

    const listResponse = await app.inject({ method: 'GET', url: '/v1/execution-receipts' });
    const listed = listResponse.json();
    assert.equal(listResponse.statusCode, 200);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.meta.persistence, 'memory');
  });

  it('reports fee config and a revenue summary derived from saved receipts', async () => {
    const fees = await app.inject({ method: 'GET', url: '/v1/fees/config' });
    assert.equal(fees.json().data.collectionEnabled, false);

    const revenue = await app.inject({ method: 'GET', url: '/v1/revenue/summary' });
    const body = revenue.json().data;
    assert.equal(body.receiptCount, 1);
    assert.ok(body.projectedRevenueUsd > 0);
    assert.equal(body.collectedRevenueUsd, 0);
  });

  it('lists alerts (none raised, since the fixture provider never emits updates)', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/alerts' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, []);
  });

  it('builds a real devnet probe transaction for execution-transaction', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/markets/sol-usdc/execution-transaction',
      payload: { side: 'buy', amountUsd: 10, userPublicKey: '11111111111111111111111111111111' },
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.network, 'devnet');
    assert.equal(body.data.kind, 'devnet-probe');
    assert.ok(typeof body.data.transactionBase64 === 'string' && body.data.transactionBase64.length > 0);
    assert.ok(body.data.lastValidBlockHeight > 0);
  });

  it('rejects execution-transaction requests that exceed the server-side USD cap', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/markets/sol-usdc/execution-transaction',
      payload: { side: 'buy', amountUsd: 10_000, userPublicKey: '11111111111111111111111111111111' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'AMOUNT_EXCEEDS_LIMIT');
  });

  it('rejects execution-transaction requests with an invalid wallet address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/markets/sol-usdc/execution-transaction',
      payload: { side: 'buy', amountUsd: 10, userPublicKey: '0'.repeat(44) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_WALLET_ADDRESS');
  });

  it('never marks a receipt verified for a signature that does not resolve on-chain', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/markets/sol-usdc/execution-confirm',
      payload: {
        signature: '1'.repeat(88),
        network: 'devnet',
        side: 'buy',
        amountUsd: 10,
        userPublicKey: '11111111111111111111111111111111',
      },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'TRANSACTION_NOT_VERIFIED');
  });

  it('rejects a malformed execution-confirm request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/markets/sol-usdc/execution-confirm',
      payload: { signature: 'too-short', network: 'devnet', side: 'buy', amountUsd: 10, userPublicKey: '11111111111111111111111111111111' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_CONFIRM_REQUEST');
  });

  it('returns the verified asset registry and a single entry by symbol', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/registry' });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().data.length >= 3);

    const entry = await app.inject({ method: 'GET', url: '/v1/registry/AAPLX' });
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.json().data.symbol, 'AAPLX');
    assert.ok(entry.json().data.sources.length > 0);

    const missing = await app.inject({ method: 'GET', url: '/v1/registry/NOTREAL' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'ASSET_NOT_FOUND');
  });
});
