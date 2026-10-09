import { JsonStore } from './json-store.js';
import type { Alert } from './alert.js';
import type { MarketSnapshot } from './market.js';
import type { AlertRepository } from './alert-repository.js';
import type { FilePushTokenStore } from './push-tokens.js';
import { sendPushNotification } from './push.js';
import type { MarketProvider, MarketUpdate } from '../providers/market-provider.js';

// A threshold a user set for one market: fires when the price, or the premium over the underlying share,
// crosses it in the chosen direction.
export type AlertRule = {
  id: string;
  walletAddress: string;
  marketId: string;
  kind: 'price' | 'premium';
  direction: 'above' | 'below';
  threshold: number;
  createdAt: string;
};

// The value a rule watches right now, or null when the market can't provide it (no live reference for a premium).
export function ruleValue(rule: AlertRule, market: MarketSnapshot): number | null {
  if (rule.kind === 'price') return market.price;
  if (!market.reference?.isLive) return null;
  return market.reference.premiumBps / 100;
}

export function ruleMatches(rule: AlertRule, market: MarketSnapshot): boolean {
  const value = ruleValue(rule, market);
  if (value === null) return false;
  return rule.direction === 'above' ? value >= rule.threshold : value <= rule.threshold;
}

// Same file-backed pattern as the other repositories -- rules survive a restart.
export class FileAlertRuleStore {
  private readonly store: JsonStore<AlertRule>;
  constructor(filePath: string) { this.store = new JsonStore(filePath); }
  async list(walletAddress?: string) {
    return (await this.store.list()).filter(rule => !walletAddress || rule.walletAddress === walletAddress);
  }
  add(rule: AlertRule) {
    return this.store.mutate(rows => {
      if (rows.length >= 10_000 || rows.filter(row => row.walletAddress === rule.walletAddress).length >= 100) {
        throw Object.assign(new Error('Alert rule limit reached'), { statusCode: 429 });
      }
      rows.push(structuredClone(rule)); return rule;
    });
  }
  remove(id: string, walletAddress: string) {
    return this.store.mutate(rows => {
      const index = rows.findIndex(rule => rule.id === id && rule.walletAddress === walletAddress);
      if (index < 0) return false;
      rows.splice(index, 1); return true;
    });
  }
}

// Fires a user's rule once when its condition becomes true, and re-arms it when the condition clears.
export class AlertRuleMonitor {
  private readonly firing = new Set<string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly provider: MarketProvider,
    private readonly store: FileAlertRuleStore,
    private readonly alerts: AlertRepository,
    private readonly pushTokens?: FilePushTokenStore,
  ) {}

  start() {
    this.unsubscribe = this.provider.subscribe((event: MarketUpdate) => void this.handle(event.market).catch(() => { console.error('Alert rule processing failed'); }));
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handle(market: MarketSnapshot) {
    const rules = (await this.store.list()).filter((rule) => rule.marketId === market.id);
    for (const rule of rules) {
      const matches = ruleMatches(rule, market);
      if (!matches) {
        this.firing.delete(rule.id);
        continue;
      }
      if (this.firing.has(rule.id)) continue;
      this.firing.add(rule.id);
      const value = ruleValue(rule, market);
      const unit = rule.kind === 'price' ? '' : '%';
      const alert: Omit<Alert, 'id' | 'createdAt'> = {
        marketId: market.id,
        symbol: market.base,
        kind: 'rule-triggered',
        severity: 'watch',
        premiumBps: rule.kind === 'premium' && value !== null ? Math.round(value * 100) : null,
        thresholdBps: rule.kind === 'premium' ? Math.round(rule.threshold * 100) : null,
        walletAddress: rule.walletAddress,
        message: `${market.base} ${rule.kind === 'price' ? 'price' : 'premium'} is ${rule.direction === 'above' ? 'at or above' : 'at or below'} ${rule.threshold}${unit} (now ${value === null ? 'unavailable' : `${round(value)}${unit}`}).`,
      };
      await this.alerts.save({ ...alert, id: `alr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString() });
      if (this.pushTokens) {
        const tokens = await this.pushTokens.tokensFor(rule.walletAddress);
        void sendPushNotification(tokens, `${market.base} alert`, alert.message, { marketId: market.id });
      }
    }
  }
}

function round(value: number) {
  return Number(value.toFixed(4));
}
