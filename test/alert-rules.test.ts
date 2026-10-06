import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ruleMatches, type AlertRule } from '../src/domain/alert-rules.js';
import type { MarketSnapshot } from '../src/domain/market.js';

const base: AlertRule = { id: 'r', walletAddress: 'w', marketId: 'm', kind: 'price', direction: 'above', threshold: 100, createdAt: '2026-01-01' };
const market = (price: number, premiumBps?: number) =>
  ({ id: 'm', price, reference: premiumBps === undefined ? undefined : { isLive: true, premiumBps } }) as unknown as MarketSnapshot;

describe('ruleMatches', () => {
  it('fires a price rule at or above the threshold, and below it for a below rule', () => {
    assert.equal(ruleMatches(base, market(100)), true);
    assert.equal(ruleMatches(base, market(99.99)), false);
    assert.equal(ruleMatches({ ...base, direction: 'below' }, market(99.99)), true);
  });

  it('fires a premium rule in percent, from the reference premium in basis points', () => {
    const premium: AlertRule = { ...base, kind: 'premium', direction: 'above', threshold: 2 };
    assert.equal(ruleMatches(premium, market(0, 270)), true);
    assert.equal(ruleMatches(premium, market(0, 150)), false);
  });

  it('never fires a premium rule without a live reference', () => {
    const premium: AlertRule = { ...base, kind: 'premium', threshold: -100, direction: 'below' };
    assert.equal(ruleMatches(premium, market(0)), false);
  });
});
