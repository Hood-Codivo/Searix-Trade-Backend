import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Alert } from './alert.js';
import type { MarketSnapshot } from './market.js';
import type { AlertRepository } from './alert-repository.js';
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
  private rules: AlertRule[] | null = null;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.rules) return this.rules;
    try {
      this.rules = JSON.parse(await readFile(this.filePath, 'utf8')) as AlertRule[];
    } catch {
      this.rules = [];
    }
    return this.rules;
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.rules, null, 2), 'utf8');
  }

  async list(walletAddress?: string) {
    const rules = await this.ensureLoaded();
    return rules.filter((rule) => !walletAddress || rule.walletAddress === walletAddress).map((rule) => structuredClone(rule));
  }

  async add(rule: AlertRule) {
    const rules = await this.ensureLoaded();
    rules.push(structuredClone(rule));
    await this.persist();
    return structuredClone(rule);
  }

  // Removes only the owner's rule; anyone else asking gets false and nothing changes.
  async remove(id: string, walletAddress: string) {
    const rules = await this.ensureLoaded();
    const index = rules.findIndex((rule) => rule.id === id && rule.walletAddress === walletAddress);
    if (index < 0) return false;
    rules.splice(index, 1);
    await this.persist();
    return true;
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
  ) {}

  start() {
    this.unsubscribe = this.provider.subscribe((event: MarketUpdate) => void this.handle(event.market));
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
    }
  }
}

function round(value: number) {
  return Number(value.toFixed(4));
}
