import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { positionsPnl } from '../src/domain/pnl.js';
import type { ExecutionReceipt, MarketSnapshot } from '../src/domain/market.js';

function trade(overrides: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    id: overrides.id ?? 'r', createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z', marketId: 'x-usdc', symbol: 'XYZ',
    side: 'buy', requestedUsd: 0, expectedAveragePrice: 0, expectedImpactBps: 0, qualityScore: 0, bestVenue: 'Jupiter',
    benchmarkPrice: null, premiumBps: null, verified: true, transactionSignature: 'sig', status: 'executed', network: 'mainnet-beta',
    actualAveragePrice: null, actualFilledUsd: 0, phoenixFeeUsd: 0, phoenixFeeBps: 0, feeStatus: 'projected', contentHash: 'h',
    actualBaseAmount: 0, expectedBaseAmount: 0, walletAddress: 'w', ...overrides,
  } as ExecutionReceipt;
}

const market = (base: string, price: number) => ({ base, quote: 'USDC', price }) as MarketSnapshot;

describe('positionsPnl', () => {
  it('averages cost across buys and reports unrealized P&L at the live price', () => {
    const [position] = positionsPnl(
      [trade({ id: 'a', side: 'buy', actualBaseAmount: 2, actualFilledUsd: 100, createdAt: '2026-01-01' }),
       trade({ id: 'b', side: 'buy', actualBaseAmount: 2, actualFilledUsd: 300, createdAt: '2026-01-02' })],
      [market('XYZ', 120)],
    );
    assert.equal(position.quantity, 4);
    assert.equal(position.averageCostUsd, 100);
    assert.equal(position.costBasisUsd, 400);
    assert.equal(position.marketValueUsd, 480);
    assert.equal(position.unrealizedPnlUsd, 80);
    assert.equal(position.realizedPnlUsd, 0);
  });

  it('realizes profit on sells at average cost and keeps the rest as unrealized', () => {
    const [position] = positionsPnl(
      [trade({ id: 'a', side: 'buy', actualBaseAmount: 4, actualFilledUsd: 400, createdAt: '2026-01-01' }),
       trade({ id: 'b', side: 'sell', actualBaseAmount: 1, actualFilledUsd: 150, createdAt: '2026-01-02' })],
      [market('XYZ', 100)],
    );
    assert.equal(position.quantity, 3);
    assert.equal(position.realizedPnlUsd, 50);
    assert.equal(position.costBasisUsd, 300);
    assert.equal(position.unrealizedPnlUsd, 0);
  });

  it('reports null value and unrealized P&L when there is no live price', () => {
    const [position] = positionsPnl(
      [trade({ actualBaseAmount: 1, actualFilledUsd: 10 })],
      [],
    );
    assert.equal(position.currentPriceUsd, null);
    assert.equal(position.marketValueUsd, null);
    assert.equal(position.unrealizedPnlUsd, null);
  });

  it('ignores trades without a confirmed fill', () => {
    const positions = positionsPnl([trade({ actualBaseAmount: null, actualFilledUsd: null })], []);
    assert.equal(positions.length, 0);
  });
});
