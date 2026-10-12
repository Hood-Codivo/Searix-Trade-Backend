import { strict as assert } from 'node:assert';
import { it, mock } from 'node:test';
import { Client } from '@ellipsis-labs/phoenix-sdk';
import { PhoenixProvider } from '../src/providers/phoenix-provider.js';

it('Phoenix survives startup RPC throttling and recovers without overlapping polls', async () => {
  const provider = new PhoenixProvider({ rpcUrl: 'http://localhost:8899', marketAddresses: [] });
  let attempts = 0;
  let refreshes = 0;
  let release!: () => void;
  const client = { refreshAllMarkets: async () => { refreshes++; await new Promise<void>((resolve) => { release = resolve; }); } };
  const create = mock.method(Client, 'createWithMarketAddresses', async () => {
    if (++attempts === 1) throw new Error('429 Too Many Requests');
    return client;
  });
  const log = mock.method(console, 'error', () => {});
  const internals = provider as unknown as { nextPollAt: number; pollAll(): Promise<void> };
  try {
    await provider.start();
    assert.equal(provider.status, 'degraded');
    await internals.pollAll();
    assert.equal(attempts, 1, 'cooldown prevents immediate retry');
    internals.nextPollAt = 0;
    await internals.pollAll();
    assert.equal(provider.status, 'connected');
    const pending = internals.pollAll();
    await internals.pollAll();
    assert.equal(refreshes, 1);
    await provider.stop();
    release();
    await pending;
    assert.equal(provider.status, 'idle');
  } finally {
    await provider.stop();
    create.mock.restore();
    log.mock.restore();
  }
});
