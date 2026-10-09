import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// One serialized, atomic read-modify-write queue per file, even across instances.
// File mode supports a single Node process; use Postgres for multi-process receipts.
const queues = new Map<string, Promise<unknown>>();
export class JsonStore<T> {
  constructor(private readonly filePath: string) {}
  private async read(): Promise<T[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Invalid record store');
      return parsed as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error; // Never silently erase an unreadable or corrupt store.
    }
  }
  async list() { await queues.get(this.filePath)?.catch(() => undefined); return this.read(); }
  mutate<R>(operation: (rows: T[]) => R): Promise<R> {
    const task = (queues.get(this.filePath) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const rows = await this.read();
      const result = operation(rows);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(rows), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
      return structuredClone(result);
    });
    queues.set(this.filePath, task);
    void task.finally(() => { if (queues.get(this.filePath) === task) queues.delete(this.filePath); }).catch(() => undefined);
    return task;
  }
}
