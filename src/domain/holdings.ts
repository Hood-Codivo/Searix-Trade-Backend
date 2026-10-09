import type { ExecutionReceipt } from './market.js';

export type HoldingRow = {
  symbol: string;
  boughtBase: number;
  soldBase: number;
  netBase: number;
  usdSpent: number;
  usdReceived: number;
  averageBuyPrice: number | null;
};

// Executed, verified trades for one wallet, newest first. Analysis-only receipts never count:
// they have no on-chain transaction behind them.
export function executedTradesFor(all: ExecutionReceipt[], walletAddress: string): ExecutionReceipt[] {
  const seen = new Set<string>();
  return all
    .filter((receipt) => receipt.walletAddress === walletAddress && receipt.status === 'executed' && receipt.verified)
    .filter(receipt => { const key = receipt.transactionSignature ? `${receipt.network}:${receipt.transactionSignature}` : receipt.id; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Holdings are built only from what the chain confirmed: actual filled base amounts and USD fills.
// A trade with no confirmed fill is left out rather than estimated.
export function holdingsFrom(trades: ExecutionReceipt[]): HoldingRow[] {
  const bySymbol = new Map<string, HoldingRow>();
  for (const trade of trades) {
    if (trade.actualBaseAmount === null || trade.actualFilledUsd === null) continue;
    const row = bySymbol.get(trade.symbol) ?? { symbol: trade.symbol, boughtBase: 0, soldBase: 0, netBase: 0, usdSpent: 0, usdReceived: 0, averageBuyPrice: null };
    if (trade.side === 'buy') {
      row.boughtBase += trade.actualBaseAmount;
      row.usdSpent += trade.actualFilledUsd;
    } else {
      row.soldBase += trade.actualBaseAmount;
      row.usdReceived += trade.actualFilledUsd;
    }
    bySymbol.set(trade.symbol, row);
  }
  return [...bySymbol.values()].map((row) => ({
    ...row,
    boughtBase: round(row.boughtBase, 10),
    soldBase: round(row.soldBase, 10),
    netBase: round(row.boughtBase - row.soldBase, 10),
    usdSpent: round(row.usdSpent),
    usdReceived: round(row.usdReceived),
    averageBuyPrice: row.boughtBase > 0 ? round(row.usdSpent / row.boughtBase, 10) : null,
  }));
}

function round(value: number, places = 2) {
  return Number(value.toFixed(places));
}
