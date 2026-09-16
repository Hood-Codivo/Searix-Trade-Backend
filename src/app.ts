import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { z } from 'zod';
import { calculateExecutionQuote, createExecutionReceipt, type CandleRange } from './domain/market.js';
import { previewFeePolicy, type FeePolicy } from './domain/fee-policy.js';
import { InMemoryReceiptRepository, type ReceiptRepository } from './domain/receipt-repository.js';
import { InMemoryAlertRepository, type AlertRepository } from './domain/alert-repository.js';
import { assetRegistry, getRegistryEntry } from './domain/registry.js';
import type { MarketProvider } from './providers/market-provider.js';

const marketParams = z.object({ id: z.string().min(1).max(64) });
const symbolParams = z.object({ symbol: z.string().min(1).max(16) });
const candleQuery = z.object({ range: z.enum(['1h', '1d', '1w', '1m']).optional() });
const executionQuoteBody = z.object({
  side: z.enum(['buy', 'sell']),
  amountUsd: z.number().finite().min(1).max(1_000_000),
});

export async function createApp(
  provider: MarketProvider,
  receipts: ReceiptRepository = new InMemoryReceiptRepository(),
  feePolicy: FeePolicy = previewFeePolicy,
  alerts: AlertRepository = new InMemoryAlertRepository(),
) {
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
    const parsedQuery = candleQuery.safeParse(request.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: { code: 'INVALID_RANGE', message: 'range must be one of 1h, 1d, 1w, 1m.' } });
    const range: CandleRange = parsedQuery.data.range ?? '1d';
    const values = provider.getCandles?.(market.id, range) ?? market.candles;
    // `interval` is kept alongside `range` for backward compatibility with existing clients.
    return { data: { marketId: market.id, interval: range, range, values, observedAt: market.observedAt } };
  });

  app.get('/v1/markets/:id/quality', async (request, reply) => {
    const parsed = marketParams.safeParse(request.params);
    const market = parsed.success ? provider.get(parsed.data.id) : undefined;
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    return { data: { marketId: market.id, ...market.quality, spreadBps: market.spreadBps, depthUsd: market.depthUsd, imbalance: market.imbalance, modelVersion: '0.1-preview', observedAt: market.observedAt } };
  });

  app.post('/v1/markets/:id/execution-quote', async (request, reply) => {
    const params = marketParams.safeParse(request.params);
    const body = executionQuoteBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_EXECUTION_REQUEST', message: 'Choose buy or sell and enter an amount from $1 to $1,000,000.' } });
    }
    const market = provider.get(params.data.id);
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    const quote = await calculateExecutionQuote(market, body.data.side, body.data.amountUsd, feePolicy);
    // The book itself is only simulated for tokenized-stock markets (no real Phoenix order book
    // exists for them); real crypto markets are quoted against the live on-chain book.
    return { data: quote, meta: { simulated: market.assetClass === 'tokenized-stock', liquidityBudgetBps: 25 } };
  });

  app.post('/v1/markets/:id/execution-receipts', async (request, reply) => {
    const params = marketParams.safeParse(request.params);
    const body = executionQuoteBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_RECEIPT_REQUEST', message: 'Choose buy or sell and enter a valid amount.' } });
    }
    const market = provider.get(params.data.id);
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    const quote = await calculateExecutionQuote(market, body.data.side, body.data.amountUsd, feePolicy);
    const saved = await receipts.save(createExecutionReceipt(market, quote));
    return reply.code(201).send({ data: saved, meta: { verified: false, reason: 'No on-chain transaction is attached.' } });
  });

  app.get('/v1/execution-receipts', async () => ({
    data: await receipts.list(),
    meta: { persistence: receipts.constructor.name === 'InMemoryReceiptRepository' ? 'memory' : 'file', verification: 'analysis-only' },
  }));

  app.get('/v1/fees/config', async () => ({
    data: {
      standardFeeBps: feePolicy.standardFeeBps,
      proFeeBps: feePolicy.proFeeBps,
      collectionEnabled: feePolicy.enabled,
      treasuryConfigured: Boolean(feePolicy.treasuryAddress),
    },
  }));

  app.get('/v1/revenue/summary', async () => {
    const saved = await receipts.list();
    return {
      data: {
        currency: 'USD',
        receiptCount: saved.length,
        projectedRevenueUsd: Number(saved.reduce((sum, receipt) => sum + receipt.phoenixFeeUsd, 0).toFixed(2)),
        collectedRevenueUsd: Number(saved.filter((receipt) => receipt.feeStatus === 'collected').reduce((sum, receipt) => sum + receipt.phoenixFeeUsd, 0).toFixed(2)),
        collectionEnabled: feePolicy.enabled,
      },
    };
  });

  app.get('/v1/alerts', async () => ({ data: await alerts.list() }));

  app.get('/v1/registry', async () => ({ data: assetRegistry }));

  app.get('/v1/registry/:symbol', async (request, reply) => {
    const parsed = symbolParams.safeParse(request.params);
    const entry = parsed.success ? getRegistryEntry(parsed.data.symbol) : undefined;
    if (!entry) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'No registry entry for that symbol.' } });
    return { data: entry };
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
