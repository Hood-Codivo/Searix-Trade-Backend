import type { ExecutionReceipt } from './market.js';
import type { ReceiptRepository } from './receipt-repository.js';
import { getPool } from './db.js';
import { PostgresJsonbRepository } from './postgres-jsonb-repository.js';

// Real persistence: survives a Render redeploy, unlike FileReceiptRepository's local JSON file on
// an ephemeral filesystem. `importFromFilePath` migrates any records left over from the file-backed
// era in on first startup.
export class PostgresReceiptRepository implements ReceiptRepository {
  private readonly inner: PostgresJsonbRepository<ExecutionReceipt>;

  constructor(importFromFilePath?: string) {
    this.inner = new PostgresJsonbRepository<ExecutionReceipt>(getPool(), 'execution_receipts', importFromFilePath);
  }

  list() {
    return this.inner.list();
  }

  save(receipt: ExecutionReceipt) {
    return this.inner.save(receipt);
  }
}
