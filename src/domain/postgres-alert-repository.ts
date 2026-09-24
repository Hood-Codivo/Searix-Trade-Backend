import type { Alert } from './alert.js';
import type { AlertRepository } from './alert-repository.js';
import { getPool } from './db.js';
import { PostgresJsonbRepository } from './postgres-jsonb-repository.js';

// Real persistence: survives a Render redeploy, unlike FileAlertRepository's local JSON file on an
// ephemeral filesystem. `importFromFilePath` migrates any records left over from the file-backed
// era in on first startup.
export class PostgresAlertRepository implements AlertRepository {
  private readonly inner: PostgresJsonbRepository<Alert>;

  constructor(importFromFilePath?: string) {
    this.inner = new PostgresJsonbRepository<Alert>(getPool(), 'alerts', importFromFilePath);
  }

  list() {
    return this.inner.list();
  }

  save(alert: Alert) {
    return this.inner.save(alert);
  }
}
