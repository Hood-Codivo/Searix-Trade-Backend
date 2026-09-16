import { evaluatePremiumAlert } from '../domain/alert.js';
import type { AlertRepository } from '../domain/alert-repository.js';
import type { MarketProvider, MarketUpdate } from './market-provider.js';

// Watches real market updates as they arrive (no polling of its own) and turns a real premium
// breach into a persisted alert. Fires once per breach episode, not once per refresh cycle.
export class PegAlertMonitor {
  private readonly breached = new Set<string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly provider: MarketProvider,
    private readonly alerts: AlertRepository,
  ) {}

  start() {
    this.unsubscribe = this.provider.subscribe((event) => void this.handleUpdate(event));
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handleUpdate(event: MarketUpdate) {
    const market = event.market;
    const { alert, breached } = evaluatePremiumAlert(market, this.breached.has(market.id));

    if (breached) this.breached.add(market.id);
    else this.breached.delete(market.id);

    if (!alert) return;
    await this.alerts.save({
      ...alert,
      id: `alr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    });
  }
}
