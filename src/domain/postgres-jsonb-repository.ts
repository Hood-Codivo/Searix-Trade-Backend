import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

// Shared by PostgresReceiptRepository and PostgresAlertRepository -- both are "append-only records,
// keyed by id, listed newest first" with no per-field querying needs, so storing the record as JSONB
// avoids a hand-maintained column-per-field schema that has to be kept in sync with the TS type by
// hand every time it changes.
export class PostgresJsonbRepository<T extends { id: string; createdAt: string }> {
  private migrated = false;

  constructor(
    private readonly pool: Pool,
    // Only ever passed as a hardcoded literal by our own repository classes below, never derived
    // from a request -- safe to interpolate into SQL.
    private readonly table: 'execution_receipts' | 'alerts',
    private readonly importFromFilePath?: string,
  ) {}

  private async ensureReady() {
    if (this.migrated) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_created_at_idx ON ${this.table} (created_at DESC)`);
    await this.importExistingFile();
    this.migrated = true;
  }

  // One-time, idempotent (ON CONFLICT DO NOTHING keyed on id): if a local JSON file from the old
  // file-backed repository still has records, bring them into the database on first startup rather
  // than silently losing them when this switches from file to Postgres persistence.
  private async importExistingFile() {
    if (!this.importFromFilePath) return;
    try {
      const raw = await readFile(this.importFromFilePath, 'utf8');
      const records = JSON.parse(raw) as T[];
      for (const record of records) {
        await this.pool.query(
          `INSERT INTO ${this.table} (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [record.id, record.createdAt, JSON.stringify(record)],
        );
      }
    } catch {
      // No existing file, or it's unreadable -- nothing to import.
    }
  }

  async list(): Promise<T[]> {
    await this.ensureReady();
    const result = await this.pool.query(`SELECT data FROM ${this.table} ORDER BY created_at DESC`);
    return result.rows.map((row) => row.data as T);
  }

  async save(record: T): Promise<T> {
    await this.ensureReady();
    await this.pool.query(
      `INSERT INTO ${this.table} (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [record.id, record.createdAt, JSON.stringify(record)],
    );
    return record;
  }
}
