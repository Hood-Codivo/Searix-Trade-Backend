import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { it, mock } from 'node:test';
import { recordTick } from '../src/domain/clickhouse.js';

it('ClickHouse retries initialization after cooldown instead of caching a rejection forever', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    requests++;
    res.statusCode = requests === 1 ? 503 : 200;
    res.end(requests === 1 ? 'temporarily unavailable' : '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previous = process.env.CLICKHOUSE_URL;
  process.env.CLICKHOUSE_URL = `http://127.0.0.1:${address.port}`;
  const log = mock.method(console, 'error', () => {});
  const now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    await recordTick('test', 1);
    assert.equal(requests, 1);
    await recordTick('test', 2);
    assert.equal(requests, 1, 'cooldown suppresses requests');
    clock.mock.mockImplementation(() => now + 30_001);
    await recordTick('test', 3);
    assert.equal(requests, 4, 'database, table, and insert succeed after retry');
  } finally {
    clock.mock.restore();
    log.mock.restore();
    if (previous === undefined) delete process.env.CLICKHOUSE_URL;
    else process.env.CLICKHOUSE_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
