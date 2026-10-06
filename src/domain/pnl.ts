import type { ExecutionReceipt, MarketSnapshot } from './market.js';

export type PositionPnl = {
  symbol: string;
  quantity: number;
  averageCostUsd: number | null;
  costBasisUsd: number;
  currentPriceUsd: number | null;
  marketValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  realizedPnlUsd: number;
};

// Average-cost P&L over a wallet's confirmed trades, applied in time order. Each sell realizes
// (proceeds - average cost of the base sold); unrealized is what the remaining quantity is worth at the
// current market price. Positions with no live price report null for value and unrealized P&L rather than
// a made-up number.
export function positionsPnl(trades: ExecutionReceipt[], markets: MarketSnapshot[]): PositionPnl[] {
  const chronological = [...trades].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const state = new Map<string, { quantity: number; costBasisUsd: number; realizedPnlUsd: number }>();

  for (const trade of chronological) {
    if (trade.actualBaseAmount === null || trade.actualFilledUsd === null) continue;
    const position = state.get(trade.symbol) ?? { quantity: 0, costBasisUsd: 0, realizedPnlUsd: 0 };
    if (trade.side === 'buy') {
      position.quantity += trade.actualBaseAmount;
      position.costBasisUsd += trade.actualFilledUsd;
    } else {
      const averageCost = position.quantity > 0 ? position.costBasisUsd / position.quantity : 0;
      const soldCost = averageCost * Math.min(trade.actualBaseAmount, position.quantity);
      position.realizedPnlUsd += trade.actualFilledUsd - soldCost;
      position.costBasisUsd -= soldCost;
      position.quantity -= Math.min(trade.actualBaseAmount, position.quantity);
    }
    state.set(trade.symbol, position);
  }

  return [...state.entries()].map(([symbol, position]) => {
    const market = markets.find((item) => item.base === symbol && item.quote === 'USDC');
    const currentPriceUsd = market ? market.price : null;
    const averageCostUsd = position.quantity > 0 ? position.costBasisUsd / position.quantity : null;
    const marketValueUsd = currentPriceUsd !== null ? position.quantity * currentPriceUsd : null;
    const unrealizedPnlUsd = marketValueUsd !== null ? marketValueUsd - position.costBasisUsd : null;
    return {
      symbol,
      quantity: round(position.quantity, 10),
      averageCostUsd: averageCostUsd !== null ? round(averageCostUsd, 10) : null,
      costBasisUsd: round(position.costBasisUsd),
      currentPriceUsd: currentPriceUsd !== null ? round(currentPriceUsd, 10) : null,
      marketValueUsd: marketValueUsd !== null ? round(marketValueUsd) : null,
      unrealizedPnlUsd: unrealizedPnlUsd !== null ? round(unrealizedPnlUsd) : null,
      realizedPnlUsd: round(position.realizedPnlUsd),
    };
  });
}

function round(value: number, places = 2) {
  return Number(value.toFixed(places));
}
