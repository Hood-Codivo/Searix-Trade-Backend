import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

// Shared by PostgresReceiptRepository and PostgresAlertRepository -- both are "append-only records,
// keyed by id, listed newest first" with no per-field querying needs, so storing the record as JSONB
// avoids a hand-maintained column-per-field schema that has to be kept in sync with the TS type by
// hand every time it changes.
export class PostgresJsonbRepository<T extends { id: string; createdAt: string }> {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    // Only ever passed as a hardcoded literal by our own repository classes below, never derived
    // from a request -- safe to interpolate into SQL.
    private readonly table: 'execution_receipts' | 'alerts',
    private readonly importFromFilePath?: string,
  ) {}

  private ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.initialize().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  private async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_created_at_idx ON ${this.table} (created_at DESC)`);
    if (this.table === 'execution_receipts') await this.pool.query(`CREATE INDEX IF NOT EXISTS execution_receipts_signature_idx ON execution_receipts ((data->>'network'), (data->>'transactionSignature'))`);
    await this.importExistingFile();

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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async list(): Promise<T[]> {
    await this.ensureReady();
    const result = await this.pool.query(`SELECT data FROM ${this.table} ORDER BY created_at DESC`);
    return result.rows.map((row) => row.data as T);
  }

  async save(record: T): Promise<T> {
    await this.ensureReady();
    // Serialize signature claims across all API replicas without deleting legacy records.
    const execution = record as T & { transactionSignature?: string; network?: string };
    if (this.table === 'execution_receipts' && execution.transactionSignature) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const key = `${execution.network}:${execution.transactionSignature}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        const existing = await client.query(
          `SELECT data FROM execution_receipts WHERE data->>'network' = $1 AND data->>'transactionSignature' = $2 ORDER BY created_at ASC LIMIT 1`,
          [execution.network, execution.transactionSignature],
        );
        if (existing.rows.length) { await client.query('COMMIT'); return existing.rows[0].data as T; }
        await client.query(`INSERT INTO execution_receipts (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [record.id, record.createdAt, JSON.stringify(record)]);
        await client.query('COMMIT'); return record;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    await this.pool.query(
      `INSERT INTO ${this.table} (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [record.id, record.createdAt, JSON.stringify(record)],
    );
    return record;
  }
}
