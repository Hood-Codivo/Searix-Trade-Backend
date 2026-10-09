import { JsonStore } from './json-store.js';
import type { Alert } from './alert.js';

export interface AlertRepository {
  list(): Promise<Alert[]>;
  save(alert: Alert): Promise<Alert>;
}

export class InMemoryAlertRepository implements AlertRepository {
  private readonly alerts: Alert[] = [];

  async list() { return this.alerts.map((alert) => structuredClone(alert)); }

  async save(alert: Alert) {
    this.alerts.unshift(structuredClone(alert));
    this.alerts.splice(10_000);
    return structuredClone(alert);
  }
}

export class FileAlertRepository implements AlertRepository {
  private readonly store: JsonStore<Alert>;
  constructor(filePath: string) { this.store = new JsonStore(filePath); }
  list() { return this.store.list(); }
  save(alert: Alert) {
    return this.store.mutate(rows => { rows.unshift(structuredClone(alert)); rows.splice(10_000); return alert; });
  }
}
