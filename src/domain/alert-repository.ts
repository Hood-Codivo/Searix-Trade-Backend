import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
    return structuredClone(alert);
  }
}

// Same file-backed pattern as FileReceiptRepository -- alerts survive a process restart.
export class FileAlertRepository implements AlertRepository {
  private alerts: Alert[] | null = null;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.alerts) return this.alerts;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.alerts = JSON.parse(raw) as Alert[];
    } catch {
      this.alerts = [];
    }
    return this.alerts;
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.alerts, null, 2), 'utf8');
  }

  async list() {
    const alerts = await this.ensureLoaded();
    return alerts.map((alert) => structuredClone(alert));
  }

  async save(alert: Alert) {
    const alerts = await this.ensureLoaded();
    alerts.unshift(structuredClone(alert));
    await this.persist();
    return structuredClone(alert);
  }
}
