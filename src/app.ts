import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerSecurity, addressSchema, ownReceipts, page } from './domain/security.js';
import { ExecutionIntents, messageHash } from './domain/execution-intent.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { calculateExecutionQuote, createExecutionReceipt, deriveReferenceAndBase, round, type CandleRange } from './domain/market.js';
import { previewFeePolicy, type FeePolicy } from './domain/fee-policy.js';
import { previewExecutionConfig, type ExecutionConfig } from './domain/execution-config.js';
import { verifyTransactionSucceeded, extractTokenFill, transactionMessageHash, transferredToAccount } from './domain/transaction-verifier.js';
import { deriveTreasuryFeeAccount } from './domain/treasury.js';
import { InMemoryReceiptRepository, type ReceiptRepository } from './domain/receipt-repository.js';
import { InMemoryAlertRepository, type AlertRepository } from './domain/alert-repository.js';
import { assetRegistry, getRegistryEntry } from './domain/registry.js';
import { executedTradesFor, holdingsFrom } from './domain/holdings.js';
import { readWalletBalances } from './domain/wallet-balances.js';
import { positionsPnl } from './domain/pnl.js';
import { FileAlertRuleStore } from './domain/alert-rules.js';
import { FilePushTokenStore } from './domain/push-tokens.js';
import type { MarketProvider } from './providers/market-provider.js';
import { fetchJupiterSwapQuote } from './providers/jupiter-swap-quote.js';
import { buildJupiterSwapTransaction } from './providers/jupiter-swap-builder.js';
import { shortfallFor, simulateBeforeSigning } from './domain/simulation.js';
import { tokenProgramForMint } from './domain/treasury.js';

// Reports what a receipt/alert repository is actually backed by, rather than a hardcoded label --
// keeps this honest as PostgresReceiptRepository/PostgresAlertRepository get added alongside the
// existing memory/file options.
function persistenceLabel(repository: ReceiptRepository | AlertRepository): 'memory' | 'file' | 'database' {
  const name = repository.constructor.name;
  if (name.startsWith('Postgres')) return 'database';
  if (name.startsWith('InMemory')) return 'memory';
  return 'file';
}

function tokenAtoms(amount: number, decimals: number) {
  const value = Math.round(amount * 10 ** decimals);
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Amount exceeds token precision limits'), { statusCode: 400 });
  return BigInt(value);
}

const marketParams = z.object({ id: z.string().min(1).max(64) });
const symbolParams = z.object({ symbol: z.string().min(1).max(16) });
const walletParams = z.object({ address: addressSchema });
const pushTokenBody = z.object({ token: z.string().min(10).max(200) });
const alertRuleBody = z.object({
  walletAddress: addressSchema,
  marketId: z.string().min(1).max(64),
  kind: z.enum(['price', 'premium']),
  direction: z.enum(['above', 'below']),
  threshold: z.number().finite(),
});
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
  executionIntent: z.string().min(1).max(60_000),
  signature: z.string().min(32).max(128),
  network: z.literal('mainnet-beta'),
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
  alertRules: FileAlertRuleStore = new FileAlertRuleStore('data/alert-rules.json'),
  verificationServices = { verifyTransactionSucceeded, transactionMessageHash },
  pushTokens: FilePushTokenStore = new FilePushTokenStore('data/push-tokens.json'),
) {
  const trustedProxies = process.env.TRUSTED_PROXY_IPS?.split(',').map(value => value.trim()).filter(Boolean);
  const app = Fastify({ bodyLimit: 65_536, requestTimeout: 15_000, connectionTimeout: 15_000,
    trustProxy: trustedProxies?.length ? trustedProxies : false,
    logger: process.env.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.body.signature', 'req.body.executionIntent'] } });
  const origins = (process.env.CORS_ORIGINS ?? 'https://searixtrade.com,https://www.searixtrade.com').split(',').map(value => value.trim()).filter(Boolean);
  await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] });
  await registerSecurity(app);
  await app.register(websocket, { options: { maxPayload: 1024 } });
  const intents = new ExecutionIntents();
  const mainnetConnection = new Connection(executionConfig.rpcUrls.mainnet, 'confirmed');
  app.setErrorHandler((caught, request, reply) => {
    const error = caught as { statusCode?: number; name?: string; code?: string };
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    request.log.error({ err: { name: error.name, code: error.code } }, 'Request failed');
    return reply.code(status).send({ error: { code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? 'Request could not be completed. Please try again.' : 'Request is invalid or exceeds a limit.' } });
  });

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
    const saved = await receipts.save(createExecutionReceipt(market, quote, { walletAddress: request.walletAddress! }));
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

    if (!market.baseMint || !market.quoteMint || market.baseDecimals === undefined || market.quoteDecimals === undefined) {
      return reply.code(400).send({ error: { code: 'MARKET_NOT_EXECUTABLE', message: 'This market has no known on-chain mints to route a real swap.' } });
    }

    let requestedBase: number;
    try {
      ({ requestedBase } = deriveReferenceAndBase(market, body.data.side, body.data.amountUsd));
    } catch {
      return reply.code(400).send({ error: { code: 'ORDER_BOOK_EMPTY', message: 'No live price is available for this market right now.' } });
    }

    // Route selection: the same best-live-venue decision the quote shows. Phoenix wins when its
    // on-chain book gives the better price; otherwise Jupiter. A failed Phoenix build is an error,
    // not a silent switch to Jupiter, so the executed route always matches the quote the user saw.
    const quote = await calculateExecutionQuote(market, body.data.side, body.data.amountUsd, feePolicy);
    const bestVenue = quote.venueQuotes.find((row) => row.best)?.venue;
    if (bestVenue === 'Phoenix') {
      // Fee is taken from the input side: the user spends `grossInput`, of which `feeAtoms` go to
      // the treasury and the rest is what the Phoenix swap actually trades.
      const inputMintForFee = body.data.side === 'buy' ? market.quoteMint : market.baseMint;
      const inputDecimalsForFee = body.data.side === 'buy' ? market.quoteDecimals : market.baseDecimals;
      const grossInput = body.data.side === 'buy' ? body.data.amountUsd : requestedBase;
      const grossAtoms = tokenAtoms(grossInput, inputDecimalsForFee);
      const feeBps = feePolicy.enabled && feePolicy.treasuryAddress ? feePolicy.standardFeeBps : 0;
      const feeAtoms = grossAtoms * BigInt(feeBps) / 10_000n;
      const netAtoms = grossAtoms - feeAtoms;
      if (netAtoms <= 0n) return reply.code(400).send({ error: { code: 'AMOUNT_TOO_SMALL', message: 'That amount rounds to zero on-chain.' } });
      const fee = feeAtoms > 0n && feePolicy.treasuryAddress
        ? { mint: inputMintForFee!, decimals: inputDecimalsForFee!, amountAtoms: feeAtoms, owner: feePolicy.treasuryAddress, destinationAccount: deriveTreasuryFeeAccount(feePolicy.treasuryAddress, inputMintForFee!) }
        : undefined;

      const phoenixInAmount = Number(netAtoms) / 10 ** inputDecimalsForFee!;
      const phoenixBuilt = await provider.buildSwapTransaction?.(market.id, body.data.side, phoenixInAmount, new PublicKey(body.data.userPublicKey), fee);
      if (!phoenixBuilt) return reply.code(502).send({ error: { code: 'TRANSACTION_BUILD_FAILED', message: 'Phoenix cannot fill this order size on its current book. Try a different amount.' } });
      const executionIntent = intents.issue({ wallet: body.data.userPublicKey, market: { ...market, bids: [], asks: [], candles: [] }, quote,
        messageHash: await messageHash(phoenixBuilt.transactionBase64, mainnetConnection), feeAccount: fee?.destinationAccount });
      return { data: { ...phoenixBuilt, executionIntent, network: 'mainnet-beta', kind: 'phoenix-swap', venue: 'Phoenix' } };
    }

    const inputMint = body.data.side === 'buy' ? market.quoteMint : market.baseMint;
    const outputMint = body.data.side === 'buy' ? market.baseMint : market.quoteMint;
    const inputDecimals = body.data.side === 'buy' ? market.quoteDecimals : market.baseDecimals;
    const inputAmount = body.data.side === 'buy' ? body.data.amountUsd : requestedBase;
    const inputAtoms = tokenAtoms(inputAmount, inputDecimals);
    if (inputAtoms <= 0n) return reply.code(400).send({ error: { code: 'AMOUNT_TOO_SMALL', message: 'That amount rounds to zero on-chain.' } });

    const spendMint = inputMint!;
    const spendDecimals = inputDecimals!;
    const spendSymbol = body.data.side === 'buy' ? market.quote : market.base;
    const shortfall = await shortfallFor(body.data.userPublicKey, spendMint, spendSymbol, inputAtoms, spendDecimals, executionConfig.rpcUrls.mainnet, tokenProgramForMint(spendMint));
    if (shortfall) return reply.code(400).send({ error: { code: 'INSUFFICIENT_BALANCE', message: `Not enough to place this order: ${shortfall}` } });

    const platformFeeBps = feePolicy.enabled ? feePolicy.standardFeeBps : undefined;
    const swapQuote = await fetchJupiterSwapQuote(inputMint, outputMint, inputAtoms.toString(), platformFeeBps);
    if (!swapQuote) return reply.code(502).send({ error: { code: 'QUOTE_UNAVAILABLE', message: 'Could not get a live swap route for this trade right now.' } });

    const feeAccount = feePolicy.enabled && feePolicy.treasuryAddress
      ? deriveTreasuryFeeAccount(feePolicy.treasuryAddress, outputMint)
      : undefined;

    const built = await buildJupiterSwapTransaction({ quoteResponse: swapQuote.raw, userPublicKey: body.data.userPublicKey, feeAccount });
    if (!built) return reply.code(502).send({ error: { code: 'TRANSACTION_BUILD_FAILED', message: 'Could not build a live swap transaction right now.' } });
    const check = await simulateBeforeSigning(built.transactionBase64, executionConfig.rpcUrls.mainnet);
    if (!check.ok) return reply.code(422).send({ error: { code: 'SIMULATION_FAILED', message: `This swap would fail on-chain: ${check.reason}` } });
    const executionIntent = intents.issue({ wallet: body.data.userPublicKey, market: { ...market, bids: [], asks: [], candles: [] }, quote,
      messageHash: await messageHash(built.transactionBase64, mainnetConnection), feeAccount });
    return { data: { ...built, executionIntent, network: 'mainnet-beta', kind: 'jupiter-swap', venue: 'Jupiter' } };
  });

  app.post('/v1/markets/:id/execution-confirm', async (request, reply) => {
    const params = marketParams.safeParse(request.params);
    const body = executionConfirmBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_CONFIRM_REQUEST', message: 'A signature, network, side, amount, and wallet address are required.' } });
    }
    const intent = intents.read(body.data.executionIntent);
    if (!intent || intent.wallet !== request.walletAddress || intent.market.id !== params.data.id ||
        intent.quote.side !== body.data.side || intent.quote.requestedUsd !== round(body.data.amountUsd)) {
      return reply.code(422).send({ error: { code: 'INVALID_EXECUTION_INTENT', message: 'This confirmation does not match a prepared trade, or it has expired.' } });
    }
    const market = intent.market;

    const verification = await verificationServices.verifyTransactionSucceeded(body.data.signature, body.data.network, executionConfig.rpcUrls);
    if (!verification.success || !verification.transaction) {
      return reply.code(422).send({ error: { code: 'TRANSACTION_NOT_VERIFIED', message: 'That transaction could not be confirmed as successful on-chain.' } });
    }

    const confirmedHash = await verificationServices.transactionMessageHash(body.data.signature, executionConfig.rpcUrls);
    const signedByWallet = verification.transaction.transaction.message.accountKeys.some(key => key.signer && key.pubkey.toBase58() === request.walletAddress);
    if (!signedByWallet || confirmedHash !== intent.messageHash) {
      return reply.code(422).send({ error: { code: 'TRANSACTION_MISMATCH', message: 'The on-chain transaction does not match the prepared trade.' } });
    }
    let actualAveragePrice: number | null = null;
    let actualFilledUsd: number | null = null;
    let actualBaseAmount: number | null = null;
    if (body.data.network === 'mainnet-beta' && market.baseMint && market.quoteMint && market.baseDecimals !== undefined && market.quoteDecimals !== undefined) {
      const inputMint = body.data.side === 'buy' ? market.quoteMint : market.baseMint;
      const outputMint = body.data.side === 'buy' ? market.baseMint : market.quoteMint;
      const inputDecimals = body.data.side === 'buy' ? market.quoteDecimals : market.baseDecimals;
      const outputDecimals = body.data.side === 'buy' ? market.baseDecimals : market.quoteDecimals;
      // Only a Phoenix swap pays the platform fee on the input mint; a Jupiter fee lands on the output
      // mint, so the treasury-account match below never counts it against the input.
      const feeAccountForFill = intent.feeAccount;
      const fill = extractTokenFill(verification.transaction, body.data.userPublicKey, inputMint, outputMint, inputDecimals, outputDecimals, feeAccountForFill);
      if (fill) {
        // The base asset is what comes in on a buy and what goes out on a sell.
        actualBaseAmount = round(body.data.side === 'buy' ? fill.outputAmount : fill.inputAmount, 10);
        if (body.data.side === 'buy') {
          actualFilledUsd = round(fill.inputAmount);
          actualAveragePrice = fill.outputAmount > 0 ? round(fill.inputAmount / fill.outputAmount, 10) : null;
        } else {
          actualFilledUsd = round(fill.outputAmount);
          actualAveragePrice = fill.inputAmount > 0 ? round(fill.outputAmount / fill.inputAmount, 10) : null;
        }
      }
    }

    if (actualBaseAmount === null || actualFilledUsd === null || actualAveragePrice === null) {
      return reply.code(422).send({ error: { code: 'FILL_NOT_VERIFIED', message: 'The transaction succeeded but its swap amounts could not be verified. Do not submit the trade again; retry confirmation.' } });
    }
    const feeMint = intent.quote.venueQuotes.find(row => row.best)?.venue === 'Phoenix'
      ? (body.data.side === 'buy' ? market.quoteMint! : market.baseMint!)
      : (body.data.side === 'buy' ? market.baseMint! : market.quoteMint!);
    const feeCollected = Boolean(intent.feeAccount && transferredToAccount(verification.transaction, intent.feeAccount, feeMint) > 0);
    const saved = await receipts.save(createExecutionReceipt(market, intent.quote, {
      verified: true, transactionSignature: body.data.signature, network: body.data.network,
      status: 'executed', actualAveragePrice, actualFilledUsd, actualBaseAmount,
      walletAddress: request.walletAddress!, feeCollected,
    }));
    if (saved.walletAddress !== request.walletAddress) return reply.code(409).send({ error: { code: 'SIGNATURE_ALREADY_USED', message: 'This transaction is already recorded.' } });
    return reply.code(201).send({ data: saved, meta: { verified: true } });
  });

  // Average-cost profit and loss per asset, marked to the live market price.
  app.get('/v1/wallets/:address/pnl', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid wallet address.' } });
    const trades = executedTradesFor(await receipts.list(), params.data.address);
    return { data: positionsPnl(trades, provider.list()) };
  });

  // A wallet's real on-chain SOL and token balances.
  app.get('/v1/wallets/:address/balances', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid wallet address.' } });
    try {
      return { data: await readWalletBalances(params.data.address, executionConfig.rpcUrls.mainnet) };
    } catch {
      return reply.code(502).send({ error: { code: 'BALANCE_UNAVAILABLE', message: 'Could not read this wallet\'s balances right now.' } });
    }
  });

  // A wallet's own executed trades, newest first.
  app.get('/v1/wallets/:address/executions', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid wallet address.' } });
    return { data: page(executedTradesFor(await receipts.list(), params.data.address), request.query) };
  });

  // Net holdings per asset for one wallet, built from confirmed fills only.
  app.get('/v1/wallets/:address/holdings', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid wallet address.' } });
    return { data: holdingsFrom(executedTradesFor(await receipts.list(), params.data.address)) };
  });

  app.get('/v1/execution-receipts', async (request) => ({
    data: page(ownReceipts(await receipts.list(), request), request.query),
    meta: { persistence: persistenceLabel(receipts), verification: 'per-receipt' },
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

  // Market-wide alerts for everyone, plus rule alerts that belong to the asking wallet only.
  app.get('/v1/alerts', async (request) => {
    const wallet = typeof (request.query as { wallet?: unknown }).wallet === 'string' ? (request.query as { wallet: string }).wallet : undefined;
    const visible = (await alerts.list()).filter((alert) => !alert.walletAddress || alert.walletAddress === wallet);
    return { data: page(visible, request.query) };
  });

  app.get('/v1/alert-rules', async (request, reply) => {
    const wallet = (request.query as { wallet?: string }).wallet;
    const params = walletParams.safeParse({ address: wallet ?? '' });
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'Pass your wallet address to see your alerts.' } });
    return { data: page(await alertRules.list(params.data.address), request.query) };
  });

  app.post('/v1/alert-rules', async (request, reply) => {
    const body = alertRuleBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'INVALID_ALERT_RULE', message: 'Choose a market, price or premium, above or below, and a threshold.' } });
    if (!provider.get(body.data.marketId)) return reply.code(404).send({ error: { code: 'MARKET_NOT_FOUND', message: 'That market is not being tracked.' } });
    const rule = await alertRules.add({ ...body.data, id: `rule_${randomUUID()}`, createdAt: new Date().toISOString() });
    return reply.code(201).send({ data: rule });
  });

  // Registers (or replaces) this wallet's push token. Re-registering is how a toggle is turned back on.
  app.post('/v1/wallets/:address/push-token', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    const body = pushTokenBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'INVALID_PUSH_TOKEN', message: 'A valid wallet address and push token are required.' } });
    await pushTokens.register(params.data.address, body.data.token);
    return reply.code(201).send({ data: { registered: true } });
  });

  // Turns alerts off for this wallet by removing its token -- the monitor then has nothing to push to.
  app.delete('/v1/wallets/:address/push-token', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid wallet address.' } });
    await pushTokens.unregister(params.data.address);
    return { data: { registered: false } };
  });

  app.get('/v1/wallets/:address/push-token', async (request, reply) => {
    const params = walletParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'That is not a valid wallet address.' } });
    return { data: { registered: await pushTokens.isRegistered(params.data.address) } };
  });

  app.delete('/v1/alert-rules/:id', async (request, reply) => {
    const wallet = (request.query as { wallet?: string }).wallet ?? '';
    const params = z.object({ id: z.string().min(1).max(80) }).safeParse(request.params);
    if (!params.success || !(await alertRules.remove(params.data.id, wallet))) return reply.code(404).send({ error: { code: 'ALERT_RULE_NOT_FOUND', message: 'That alert is not yours or no longer exists.' } });
    return { data: { removed: true } };
  });

  app.get('/v1/registry', async () => ({ data: assetRegistry }));

  app.get('/v1/registry/:symbol', async (request, reply) => {
    const parsed = symbolParams.safeParse(request.params);
    const entry = parsed.success ? getRegistryEntry(parsed.data.symbol) : undefined;
    if (!entry) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'No registry entry for that symbol.' } });
    return { data: entry };
  });

  let openSockets = 0;
  const socketsByIp = new Map<string, number>();
  app.get('/v1/stream', { websocket: true }, (socket, request) => {
    const count = socketsByIp.get(request.ip) ?? 0;
    if (openSockets >= 200 || count >= 5) { socket.close(1013, 'Server busy'); return; }
    openSockets++;
    socketsByIp.set(request.ip, count + 1);
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false; socket.ping();
    }, 30_000);
    heartbeat.unref();
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(heartbeat); openSockets--;
      const remaining = (socketsByIp.get(request.ip) ?? 1) - 1;
      if (remaining) socketsByIp.set(request.ip, remaining); else socketsByIp.delete(request.ip);
    });
    socket.send(JSON.stringify({ type: 'stream.ready', sequence: Date.now() }));
    const unsubscribe = provider.subscribe((event) => {
      if (socket.bufferedAmount > 256_000) { socket.close(1013, 'Client too slow'); return; }
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on('close', unsubscribe);
  });

  app.addHook('onClose', async () => provider.stop());
  await provider.start();
  return app;
}
