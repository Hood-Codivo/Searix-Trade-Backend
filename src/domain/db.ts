import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

// Verify remote TLS certificates. Set DATABASE_SSL_CA for a private certificate authority.
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // pg connection-string SSL settings can override the explicit verified TLS object.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  pool = new Pool({ connectionString: url.toString(), max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 10_000,
    ssl: local ? false : { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.split(String.raw`\n`).join('\n') } : {}) } });
  return pool;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
