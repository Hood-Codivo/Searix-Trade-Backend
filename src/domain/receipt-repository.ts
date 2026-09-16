import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExecutionReceipt } from './market.js';

export interface ReceiptRepository {
  list(): Promise<ExecutionReceipt[]>;
  save(receipt: ExecutionReceipt): Promise<ExecutionReceipt>;
}

export class InMemoryReceiptRepository implements ReceiptRepository {
  private readonly receipts: ExecutionReceipt[] = [];

  async list() { return this.receipts.map((receipt) => structuredClone(receipt)); }

  async save(receipt: ExecutionReceipt) {
    this.receipts.unshift(structuredClone(receipt));
    return structuredClone(receipt);
  }
}

// Backed by a local JSON file so receipts survive a process restart, unlike InMemoryReceiptRepository.
export class FileReceiptRepository implements ReceiptRepository {
  private receipts: ExecutionReceipt[] | null = null;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.receipts) return this.receipts;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.receipts = JSON.parse(raw) as ExecutionReceipt[];
    } catch {
      this.receipts = [];
    }
    return this.receipts;
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.receipts, null, 2), 'utf8');
  }

  async list() {
    const receipts = await this.ensureLoaded();
    return receipts.map((receipt) => structuredClone(receipt));
  }

  async save(receipt: ExecutionReceipt) {
    const receipts = await this.ensureLoaded();
    receipts.unshift(structuredClone(receipt));
    await this.persist();
    return structuredClone(receipt);
  }
}
