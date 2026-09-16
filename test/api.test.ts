import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { SimulatedPhoenixProvider } from '../src/providers/simulated-phoenix-provider.js';

let app: FastifyInstance;

before(async () => { app = await createApp(new SimulatedPhoenixProvider(10_000, false)); });
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
