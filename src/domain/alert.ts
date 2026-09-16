import type { MarketSnapshot } from './market.js';

export type AlertSeverity = 'watch' | 'warning';

export type Alert = {
  id: string;
  marketId: string;
  symbol: string;
  kind: 'premium-deterioration';
  severity: AlertSeverity;
  premiumBps: number;
  thresholdBps: number;
  message: string;
  createdAt: string;
};

// Structural modeling constants (how far the premium has to drift before it's worth surfacing),
// not per-market data -- same category as venueFeeBps or the execution-quote's 25 bps budget.
export const WATCH_THRESHOLD_BPS = 150;
export const WARNING_THRESHOLD_BPS = 300;

// Pure so it's directly unit-testable without a running provider. `wasBreached` is whether this
// market was already in an active breach episode last time we checked -- an alert only fires on
// the transition into a breach, not on every refresh while it stays breached.
export function evaluatePremiumAlert(
  market: MarketSnapshot,
  wasBreached: boolean,
): { alert: Omit<Alert, 'id' | 'createdAt'> | null; breached: boolean } {
  if (!market.reference) return { alert: null, breached: false };

  const premiumBps = Math.abs(market.reference.premiumBps);
  const isBreached = premiumBps >= WATCH_THRESHOLD_BPS;

  if (!isBreached) return { alert: null, breached: false };
  if (wasBreached) return { alert: null, breached: true };

  const severity: AlertSeverity = premiumBps >= WARNING_THRESHOLD_BPS ? 'warning' : 'watch';
  const thresholdBps = severity === 'warning' ? WARNING_THRESHOLD_BPS : WATCH_THRESHOLD_BPS;
  const direction = market.reference.premiumBps >= 0 ? '+' : '';
  const rounded = Math.round(market.reference.premiumBps * 10) / 10;

  return {
    breached: true,
    alert: {
      marketId: market.id,
      symbol: market.base,
      kind: 'premium-deterioration',
      severity,
      premiumBps: rounded,
      thresholdBps,
      message: `${market.base} is trading ${direction}${rounded} bps from its ${market.underlyingSymbol ?? 'reference'} price -- outside the normal ${WATCH_THRESHOLD_BPS} bps range.`,
    },
  };
}
