import { Client, Side, getMarketSwapTransaction, type MarketState } from '@ellipsis-labs/phoenix-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { CandleHistory } from '../domain/candle-history.js';
import { recordTick } from '../domain/clickhouse.js';
import {
  calculateImbalance,
  calculateSpreadBps,
  scoreMarket,
  summarizeQuality,
  type CandleRange,
  type MarketSnapshot,
  type OrderLevel,
  type TradeSide,
} from '../domain/market.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { BuiltSwapTransaction } from './jupiter-swap-builder.js';
import { JupiterReferenceClient } from './jupiter-reference-client.js';
import type { MarketProvider, MarketUpdate, SwapFeeTransfer } from './market-provider.js';

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

// The SDK default (0.5%) is tighter than the on-chain book can meet at small sizes: the IOC swap
// fails its minimum-fill check by one lot. 2% clears it for the orders tested, and it still caps how
// far the fill can move from the quoted price.
export const PHOENIX_SWAP_SLIPPAGE = 0.02;

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
  private readonly candleHistory = new CandleHistory();
  private readonly listeners = new Set<(event: MarketUpdate) => void>();
  private readonly subscriptionIds: number[] = [];
  private readonly baseMintByAddress = new Map<string, string>();
  private readonly jupiter = new JupiterReferenceClient();
  private pollTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
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
    // Real 24h change/volume come from a separate, lower-frequency batched Jupiter call (not the
    // account-change/poll path above, which only ever sees live book state, not historical stats).
    void this.refreshStats();
    this.statsTimer = setInterval(() => void this.refreshStats(), 30_000);
  }

  async stop() {
    for (const id of this.subscriptionIds) await this.connection.removeAccountChangeListener(id);
    this.subscriptionIds.length = 0;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
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

  getCandles(id: string, range: CandleRange): number[] | undefined {
    return this.candleHistory.getCandles(id, range);
  }

  // Builds an unsigned Phoenix swap transaction against the live on-chain book. `inAmount` is in
  // whole tokens of the input side: quote (USDC) for a buy, base for a sell. Never signs anything.
  async buildSwapTransaction(id: string, side: TradeSide, inAmount: number, trader: PublicKey, fee?: SwapFeeTransfer): Promise<BuiltSwapTransaction | null> {
    const marketState = this.client?.marketStates.get(id);
    if (!marketState) return null;
    try {
      const transaction = getMarketSwapTransaction({
        market: marketState,
        trader,
        side: side === 'buy' ? Side.Bid : Side.Ask,
        inAmount,
        slippage: PHOENIX_SWAP_SLIPPAGE,
        idempotent: true,
      });
      if (fee && fee.amountAtoms > 0n) {
        // Fee leaves the trader's own input-mint account in the same atomic transaction, so a
        // failed swap also reverts the fee. Classic SPL token: the crypto markets' mints use it.
        const mint = new PublicKey(fee.mint);
        const destination = new PublicKey(fee.destinationAccount);
        transaction.add(createAssociatedTokenAccountIdempotentInstruction(trader, destination, new PublicKey(fee.owner), mint));
        transaction.add(createTransferCheckedInstruction(
          getAssociatedTokenAddressSync(mint, trader),
          mint,
          destination,
          trader,
          fee.amountAtoms,
          fee.decimals,
        ));
      }
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = trader;
      // Never hand back a swap the book can't fill: simulate it on-chain first. The SDK's minimum-fill
      // check can disagree with what the live book matches at a given size, and a failed swap would
      // otherwise only surface after the user has signed.
      const simulation = await this.connection.simulateTransaction(transaction, undefined, true);
      if (simulation.value.err) return null;

      const transactionBase64 = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      return { transactionBase64, lastValidBlockHeight };
    } catch {
      return null;
    }
  }

  private async refreshStats() {
    const mints = [...new Set(this.baseMintByAddress.values())];
    if (mints.length === 0) return;
    try {
      const stats = await this.jupiter.fetchStats(mints);
      for (const [address, mint] of this.baseMintByAddress) {
        const market = this.markets.get(address);
        const stat = stats.get(mint);
        if (!market || !stat) continue;
        market.change24h = stat.change24h;
        market.volume24h = stat.volume24h;
        this.markets.set(address, market);
        const event: MarketUpdate = { type: 'market.update', market: structuredClone(market) };
        for (const listener of this.listeners) listener(event);
      }
    } catch {
      // Real-time book data (price/bids/asks) keeps flowing regardless; only 24h stats are stale.
    }
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

    this.candleHistory.record(address, price);
    void recordTick(address, price);

    const header = marketState.data.header;
    const base = symbolForMint(header.baseParams.mintKey);
    const quote = symbolForMint(header.quoteParams.mintKey);
    const baseMint = header.baseParams.mintKey.toBase58();
    const quoteMint = header.quoteParams.mintKey.toBase58();
    this.baseMintByAddress.set(address, baseMint);

    const previous = this.markets.get(address);
    // Reuse the same real, range-aware history that /candles serves -- a separately-accumulated
    // rolling buffer here would only ever hold ~20 raw ticks (far less real spread than we
    // actually have), which is why the home-page sparkline was showing a near-flat line.
    const candles = this.candleHistory.getCandles(address, '1m') ?? [price];
    // change24h/volume24h are real, but come from a separate batched Jupiter call (refreshStats),
    // not from book updates -- carry forward whatever that last set rather than reset it here.
    const change24h = previous?.change24h ?? 0;
    const volume24h = previous?.volume24h ?? 0;

    const snapshot: MarketSnapshot = {
      id: address,
      base,
      quote,
      venue: 'Phoenix',
      price,
      change24h,
      volume24h,
      baseMint,
      quoteMint,
      baseDecimals: header.baseParams.decimals,
      quoteDecimals: header.quoteParams.decimals,
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
