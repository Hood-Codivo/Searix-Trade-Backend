import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { calculateExecutionQuote, createExecutionReceipt, deriveReferenceAndBase, round, type CandleRange } from './domain/market.js';
import { previewFeePolicy, type FeePolicy } from './domain/fee-policy.js';
import { previewExecutionConfig, type ExecutionConfig } from './domain/execution-config.js';
import { verifyTransactionSucceeded, extractTokenFill } from './domain/transaction-verifier.js';
import { deriveTreasuryFeeAccount } from './domain/treasury.js';
import { InMemoryReceiptRepository, type ReceiptRepository } from './domain/receipt-repository.js';
import { InMemoryAlertRepository, type AlertRepository } from './domain/alert-repository.js';
import { assetRegistry, getRegistryEntry } from './domain/registry.js';
import type { MarketProvider } from './providers/market-provider.js';
import { fetchJupiterSwapQuote } from './providers/jupiter-swap-quote.js';
import { buildJupiterSwapTransaction } from './providers/jupiter-swap-builder.js';
import { buildDevnetProbeTransaction } from './providers/devnet-transaction-builder.js';

// Reports what a receipt/alert repository is actually backed by, rather than a hardcoded label --
// keeps this honest as PostgresReceiptRepository/PostgresAlertRepository get added alongside the
// existing memory/file options.
function persistenceLabel(repository: ReceiptRepository | AlertRepository): 'memory' | 'file' | 'database' {
  const name = repository.constructor.name;
  if (name.startsWith('Postgres')) return 'database';
  if (name.startsWith('InMemory')) return 'memory';
  return 'file';
}

const marketParams = z.object({ id: z.string().min(1).max(64) });
const symbolParams = z.object({ symbol: z.string().min(1).max(16) });
const candleQuery = z.object({ range: z.enum(['1h', '1d', '1w', '1m']).optional() });
const executionQuoteBody = z.object({
  side: z.enum(['buy', 'sell']),
  amountUsd: z.number().finite().min(1).max(1_000_000),
});
const executionTransactionBody = z.object({
  side: z.enum(['buy', 'sell']),
  amountUsd: z.number().finite().min(1).max(1_000_000),
  userPublicKey: z.string().min(32).max(64),
});
const executionConfirmBody = z.object({
  signature: z.string().min(32).max(128),
  network: z.enum(['devnet', 'mainnet-beta']),
  side: z.enum(['buy', 'sell']),
  amountUsd: z.number().finite().min(1).max(1_000_000),
  userPublicKey: z.string().min(32).max(64),
});

export async function createApp(
  provider: MarketProvider,
  receipts: ReceiptRepository = new InMemoryReceiptRepository(),
  feePolicy: FeePolicy = previewFeePolicy,
  alerts: AlertRepository = new InMemoryAlertRepository(),
  executionConfig: ExecutionConfig = previewExecutionConfig,
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

  app.post('/v1/markets/:id/execution-transaction', async (request, reply) => {
    const params = marketParams.safeParse(request.params);
    const body = executionTransactionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_EXECUTION_REQUEST', message: 'Choose buy or sell, enter a valid amount, and provide your wallet address.' } });
    }
    if (body.data.amountUsd > executionConfig.maxExecutionUsd) {
      return reply.code(400).send({ error: { code: 'AMOUNT_EXCEEDS_LIMIT', message: `Amount exceeds the current execution limit of $${executionConfig.maxExecutionUsd}.` } });
    }
    const market = provider.get(params.data.id);
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });

    try {
      new PublicKey(body.data.userPublicKey);
    } catch {
      return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid Solana wallet address.' } });
    }

    if (executionConfig.network === 'devnet') {
      const built = await buildDevnetProbeTransaction(body.data.userPublicKey, executionConfig.rpcUrls.devnet);
      if (!built) return reply.code(502).send({ error: { code: 'TRANSACTION_BUILD_FAILED', message: 'Could not reach devnet to build a transaction right now.' } });
      return { data: { ...built, network: 'devnet', kind: 'devnet-probe' } };
    }

    if (!market.baseMint || !market.quoteMint || market.baseDecimals === undefined || market.quoteDecimals === undefined) {
      return reply.code(400).send({ error: { code: 'MARKET_NOT_EXECUTABLE', message: 'This market has no known on-chain mints to route a real swap.' } });
    }

    let requestedBase: number;
    try {
      ({ requestedBase } = deriveReferenceAndBase(market, body.data.side, body.data.amountUsd));
    } catch {
      return reply.code(400).send({ error: { code: 'ORDER_BOOK_EMPTY', message: 'No live price is available for this market right now.' } });
    }

    const inputMint = body.data.side === 'buy' ? market.quoteMint : market.baseMint;
    const outputMint = body.data.side === 'buy' ? market.baseMint : market.quoteMint;
    const inputDecimals = body.data.side === 'buy' ? market.quoteDecimals : market.baseDecimals;
    const inputAmount = body.data.side === 'buy' ? body.data.amountUsd : requestedBase;
    const inputAtoms = BigInt(Math.round(inputAmount * 10 ** inputDecimals));
    if (inputAtoms <= 0n) return reply.code(400).send({ error: { code: 'AMOUNT_TOO_SMALL', message: 'That amount rounds to zero on-chain.' } });

    const platformFeeBps = feePolicy.enabled ? feePolicy.standardFeeBps : undefined;
    const quote = await fetchJupiterSwapQuote(inputMint, outputMint, inputAtoms.toString(), platformFeeBps);
    if (!quote) return reply.code(502).send({ error: { code: 'QUOTE_UNAVAILABLE', message: 'Could not get a live swap route for this trade right now.' } });

    const feeAccount = feePolicy.enabled && feePolicy.treasuryAddress
      ? deriveTreasuryFeeAccount(feePolicy.treasuryAddress, outputMint)
      : undefined;

    const built = await buildJupiterSwapTransaction({ quoteResponse: quote.raw, userPublicKey: body.data.userPublicKey, feeAccount });
    if (!built) return reply.code(502).send({ error: { code: 'TRANSACTION_BUILD_FAILED', message: 'Could not build a live swap transaction right now.' } });
    return { data: { ...built, network: 'mainnet-beta', kind: 'jupiter-swap' } };
  });

  app.post('/v1/markets/:id/execution-confirm', async (request, reply) => {
    const params = marketParams.safeParse(request.params);
    const body = executionConfirmBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_CONFIRM_REQUEST', message: 'A signature, network, side, amount, and wallet address are required.' } });
    }
    const market = provider.get(params.data.id);
    if (!market) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });

    const verification = await verifyTransactionSucceeded(body.data.signature, body.data.network, executionConfig.rpcUrls);
    if (!verification.success || !verification.transaction) {
      return reply.code(422).send({ error: { code: 'TRANSACTION_NOT_VERIFIED', message: 'That transaction could not be confirmed as successful on-chain.' } });
    }

    let actualAveragePrice: number | null = null;
    let actualFilledUsd: number | null = null;
    if (body.data.network === 'mainnet-beta' && market.baseMint && market.quoteMint && market.baseDecimals !== undefined && market.quoteDecimals !== undefined) {
      const inputMint = body.data.side === 'buy' ? market.quoteMint : market.baseMint;
      const outputMint = body.data.side === 'buy' ? market.baseMint : market.quoteMint;
      const inputDecimals = body.data.side === 'buy' ? market.quoteDecimals : market.baseDecimals;
      const outputDecimals = body.data.side === 'buy' ? market.baseDecimals : market.quoteDecimals;
      const fill = extractTokenFill(verification.transaction, body.data.userPublicKey, inputMint, outputMint, inputDecimals, outputDecimals);
      if (fill) {
        if (body.data.side === 'buy') {
          actualFilledUsd = round(fill.inputAmount);
          actualAveragePrice = fill.outputAmount > 0 ? round(fill.inputAmount / fill.outputAmount, 10) : null;
        } else {
          actualFilledUsd = round(fill.outputAmount);
          actualAveragePrice = fill.inputAmount > 0 ? round(fill.outputAmount / fill.inputAmount, 10) : null;
        }
      }
    }

    const quote = await calculateExecutionQuote(market, body.data.side, body.data.amountUsd, feePolicy);
    const saved = await receipts.save(createExecutionReceipt(market, quote, {
      verified: true,
      transactionSignature: body.data.signature,
      network: body.data.network,
      status: 'executed',
      actualAveragePrice,
      actualFilledUsd,
    }));
    return reply.code(201).send({ data: saved, meta: { verified: true } });
  });

  app.get('/v1/execution-receipts', async () => ({
    data: await receipts.list(),
    meta: { persistence: persistenceLabel(receipts), verification: 'analysis-only' },
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
