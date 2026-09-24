import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

// Render's managed Postgres requires SSL for external connections; rejectUnauthorized is off
// because Render's own cert chain isn't in Node's default trust store, a standard tradeoff for
// platform-internal managed databases (the connection itself is still encrypted).
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  return pool;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
