import type { ExecutionReceipt } from './market.js';
import { JsonStore } from './json-store.js';

export interface ReceiptRepository {
  list(): Promise<ExecutionReceipt[]>;
  save(receipt: ExecutionReceipt): Promise<ExecutionReceipt>;
}
export function sameExecution(a: ExecutionReceipt, b: ExecutionReceipt) {
  return Boolean(a.transactionSignature && a.transactionSignature === b.transactionSignature && a.network === b.network);
}
function insert(rows: ExecutionReceipt[], receipt: ExecutionReceipt) {
  const existing = rows.find(row => row.id === receipt.id || sameExecution(row, receipt));
  if (existing) return existing;
  if (rows.length >= 50_000) throw new Error('Receipt storage capacity reached. Archive receipts or use Postgres.');
  rows.unshift(structuredClone(receipt)); return receipt;
}
export class InMemoryReceiptRepository implements ReceiptRepository {
  private readonly receipts: ExecutionReceipt[] = [];
  async list() { return structuredClone(this.receipts); }
  async save(receipt: ExecutionReceipt) { return structuredClone(insert(this.receipts, receipt)); }
}
export class FileReceiptRepository implements ReceiptRepository {
  private readonly store: JsonStore<ExecutionReceipt>;
  constructor(filePath: string) { this.store = new JsonStore(filePath); }
  list() { return this.store.list(); }
  save(receipt: ExecutionReceipt) { return this.store.mutate(rows => insert(rows, receipt)); }
}
