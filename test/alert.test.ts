import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePremiumAlert, WATCH_THRESHOLD_BPS, WARNING_THRESHOLD_BPS } from '../src/domain/alert.js';
import type { MarketSnapshot } from '../src/domain/market.js';

function stockMarket(premiumBps: number): MarketSnapshot {
  return {
    id: 'aaplx-usdc', base: 'AAPLX', quote: 'USDC', venue: 'Phoenix', price: 236.84, change24h: 0,
    volume24h: 0, spreadBps: 4, depthUsd: 100_000, imbalance: 0.5,
    assetClass: 'tokenized-stock', underlyingSymbol: 'AAPL',
    reference: { source: 'Jupiter', underlyingFeed: 'AAPL', tokenFeed: 'AAPLx', underlyingPrice: 236, tokenPrice: 236 * (1 + premiumBps / 10_000), premiumBps, marketState: 'open', isLive: true, observedAt: new Date().toISOString() },
    quality: { label: 'Clean fills', tone: 'clean', score: 90, summary: '' },
    bids: [], asks: [], candles: [236], sequence: 1, observedAt: new Date().toISOString(),
  };
}

describe('evaluatePremiumAlert', () => {
  it('does not alert when the premium is inside the normal range', () => {
    const { alert, breached } = evaluatePremiumAlert(stockMarket(50), false);
    assert.equal(alert, null);
    assert.equal(breached, false);
  });

  it('fires a watch alert on crossing the watch threshold', () => {
    const { alert, breached } = evaluatePremiumAlert(stockMarket(WATCH_THRESHOLD_BPS + 10), false);
    assert.equal(breached, true);
    assert.ok(alert);
    assert.equal(alert!.severity, 'watch');
    assert.equal(alert!.marketId, 'aaplx-usdc');
    assert.ok(alert!.message.includes('AAPLX'));
  });

  it('fires a warning alert once the premium is far enough out', () => {
    const { alert } = evaluatePremiumAlert(stockMarket(WARNING_THRESHOLD_BPS + 10), false);
    assert.equal(alert!.severity, 'warning');
  });

  it('does not re-fire while still breached (fires once per episode)', () => {
    const { alert, breached } = evaluatePremiumAlert(stockMarket(WATCH_THRESHOLD_BPS + 10), true);
    assert.equal(alert, null);
    assert.equal(breached, true);
  });

  it('allows a fresh alert after the premium recovers and breaches again', () => {
    const recovered = evaluatePremiumAlert(stockMarket(20), true);
    assert.equal(recovered.breached, false);
    const rebreached = evaluatePremiumAlert(stockMarket(WATCH_THRESHOLD_BPS + 5), recovered.breached);
    assert.ok(rebreached.alert);
  });

  it('ignores markets with no reference block (real crypto markets)', () => {
    const market = { ...stockMarket(500), reference: undefined };
    const { alert } = evaluatePremiumAlert(market, false);
    assert.equal(alert, null);
  });
});
