import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { z } from 'zod';
import type { MarketProvider } from './providers/market-provider.js';

const marketParams = z.object({ id: z.string().min(1).max(64) });

export async function createApp(provider: MarketProvider) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok', provider: provider.status, timestamp: new Date().toISOString() }));

  app.get('/v1/markets', async () => ({ data: provider.list(), meta: { provider: provider.constructor.name, simulated: provider.constructor.name.includes('Simulated') } }));

  app.get('/v1/markets/:id', async (request, reply) => {
    const parsed = marketParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_MARKET_ID', message: 'Market id is invalid.' } });
    const market = provider.get(parsed.data.id);
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    return { data: market };
  });

  app.get('/v1/markets/:id/orderbook', async (request, reply) => {
    const parsed = marketParams.safeParse(request.params);
    const market = parsed.success ? provider.get(parsed.data.id) : undefined;
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    return { data: { marketId: market.id, bids: market.bids, asks: market.asks, sequence: market.sequence, observedAt: market.observedAt } };
  });

  app.get('/v1/markets/:id/candles', async (request, reply) => {
    const parsed = marketParams.safeParse(request.params);
    const market = parsed.success ? provider.get(parsed.data.id) : undefined;
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    return { data: { marketId: market.id, interval: '1d-preview', values: market.candles, observedAt: market.observedAt } };
  });

  app.get('/v1/markets/:id/quality', async (request, reply) => {
    const parsed = marketParams.safeParse(request.params);
    const market = parsed.success ? provider.get(parsed.data.id) : undefined;
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    return { data: { marketId: market.id, ...market.quality, spreadBps: market.spreadBps, depthUsd: market.depthUsd, imbalance: market.imbalance, modelVersion: '0.1-preview', observedAt: market.observedAt } };
  });

  app.get('/v1/stream', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'stream.ready', sequence: Date.now() }));
    const unsubscribe = provider.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
  });

  app.addHook('onClose', async () => provider.stop());
  await provider.start();
  return app;
}
