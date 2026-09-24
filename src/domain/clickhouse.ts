import { createClient, type ClickHouseClient } from '@clickhouse/client';

let client: ClickHouseClient | null = null;
let ready: Promise<void> | null = null;

export function isClickhouseConfigured(): boolean {
  return Boolean(process.env.CLICKHOUSE_URL?.trim());
}

function getClient(): ClickHouseClient {
  if (client) return client;
  client = createClient({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    // Connects without a database first so we can create the configured one if it doesn't exist
    // yet, then every query below targets it explicitly.
    database: 'default',
  });
  return client;
}

function targetDatabase(): string {
  return process.env.CLICKHOUSE_DATABASE || 'default';
}

async function ensureReady(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const ch = getClient();
    const db = targetDatabase();
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });
    // MergeTree keyed on (market_id, ts) -- real tick-by-tick price history, ordered for fast
    // range scans per market. Unlike the in-memory CandleHistory (30-day cap, wiped on restart),
    // this is genuine durable storage of every real observed price.
    await ch.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${db}.market_ticks (
          market_id String,
          price Float64,
          observed_at DateTime64(3)
        ) ENGINE = MergeTree
        ORDER BY (market_id, observed_at)
      `,
    });
  })();
  return ready;
}

// Fire-and-forget: a tick-storage failure must never break the real-time market update path that
// calls this. Errors are swallowed after being surfaced once via console.error for visibility.
export async function recordTick(marketId: string, price: number, observedAt = new Date()): Promise<void> {
  if (!isClickhouseConfigured()) return;
  try {
    await ensureReady();
    const ch = getClient();
    await ch.insert({
      table: `${targetDatabase()}.market_ticks`,
      values: [{ market_id: marketId, price, observed_at: observedAt.toISOString().replace('T', ' ').replace('Z', '') }],
      format: 'JSONEachRow',
    });
  } catch (error) {
    console.error('clickhouse recordTick failed', error);
  }
}
