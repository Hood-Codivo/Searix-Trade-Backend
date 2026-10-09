import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, PublicKey, SystemProgram, Transaction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { login, signMessage } from './security-helpers.js';
import { FileAlertRuleStore } from '../src/domain/alert-rules.js';
import { FileReceiptRepository, InMemoryReceiptRepository } from '../src/domain/receipt-repository.js';
import { ExecutionIntents, messageHash } from '../src/domain/execution-intent.js';
import { extractTokenFill, verifyTransactionSucceeded } from '../src/domain/transaction-verifier.js';
import { createExecutionReceipt, type ExecutionQuote, type MarketSnapshot } from '../src/domain/market.js';
import { previewFeePolicy } from '../src/domain/fee-policy.js';
import { previewExecutionConfig } from '../src/domain/execution-config.js';
import { executedTradesFor } from '../src/domain/holdings.js';

const baseMint = Keypair.generate().publicKey.toBase58();
const quoteMint = Keypair.generate().publicKey.toBase58();
const market = { id: 'test-market', base: 'TEST', quote: 'USDC', venue: 'Phoenix', price: 2, bids: [], asks: [], candles: [],
  baseMint, quoteMint, baseDecimals: 6, quoteDecimals: 6, quality: { score: 90 }, observedAt: new Date().toISOString() } as unknown as MarketSnapshot;
const quote = { side: 'buy', requestedUsd: 10, averagePrice: 2, priceImpactBps: 0, qualityScore: 90,
  feeBreakdown: { phoenixFeeUsd: 0.015, phoenixFeeBps: 15, collectionEnabled: true }, venueQuotes: [{ venue: 'Phoenix', best: true, expectedBase: 5 }] } as ExecutionQuote;
const provider = () => ({ status: 'connected' as const, start: async () => {}, stop: async () => {}, get: (id: string) => id === market.id ? market : undefined, list: () => [market], subscribe: () => () => {} });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'searix-security-'));
  const app = await createApp(provider(), undefined, undefined, undefined, undefined, new FileAlertRuleStore(join(directory, 'rules.json')));
  return { app, close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

describe('wallet authentication and isolation', () => {
  it('requires a real signature, consumes a nonce once, and revokes sessions', async () => {
    const { app, close } = await fixture();
    try {
      const wallet = Keypair.generate();
      const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { walletAddress: wallet.publicKey.toBase58() } })).json().data;
      const payload = { nonce: challenge.nonce, signature: signMessage(wallet, challenge.message) };
      const accepted = await app.inject({ method: 'POST', url: '/v1/auth/session', payload });
      assert.equal(accepted.statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session', payload })).statusCode, 401);
      const headers = { authorization: `Bearer ${accepted.json().data.token}` };
      assert.equal((await app.inject({ method: 'GET', url: '/v1/execution-receipts', headers })).statusCode, 200);
      await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers });
      assert.equal((await app.inject({ method: 'GET', url: '/v1/execution-receipts', headers })).statusCode, 401);
      const another = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { walletAddress: wallet.publicKey.toBase58() } })).json().data;
      assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { nonce: another.nonce, signature: signMessage(Keypair.generate(), another.message) } })).statusCode, 401);
      const expiring = await login(app, wallet);
      const now = Date.now;
      try {
        Date.now = () => now() + 61 * 60_000;
        assert.equal((await app.inject({ url: '/v1/execution-receipts', headers: expiring.headers })).statusCode, 401);
      } finally { Date.now = now; }
    } finally { await close(); }
  });
  it('does not let another wallet read, create or delete private alert rules', async () => {
    const { app, close } = await fixture();
    try {
      const owner = await login(app); const attacker = await login(app);
      const walletAddress = owner.wallet.publicKey.toBase58();
      const payload = { walletAddress, marketId: market.id, kind: 'price', direction: 'above', threshold: 5 };
      assert.equal((await app.inject({ method: 'POST', url: '/v1/alert-rules', payload })).statusCode, 401);
      const saved = await app.inject({ method: 'POST', url: '/v1/alert-rules', headers: owner.headers, payload });
      assert.equal(saved.statusCode, 201);
      for (const method of ['GET', 'DELETE'] as const) {
        const url = `/v1/alert-rules${method === 'DELETE' ? `/${saved.json().data.id}` : ''}?wallet=${walletAddress}`;
        assert.equal((await app.inject({ method, url, headers: attacker.headers })).statusCode, 403);
      }
      assert.equal((await app.inject({ method: 'POST', url: '/v1/alert-rules', headers: attacker.headers, payload })).statusCode, 403);
      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/alert-rules/${saved.json().data.id}?wallet=${walletAddress}`, headers: owner.headers })).statusCode, 200);
    } finally { await close(); }
  });
  it('restricts CORS and applies rate limits independent of forged proxy headers', async () => {
    const { app, close } = await fixture();
    try {
      const invalidAddress = await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { walletAddress: '1'.repeat(10_000) } });
      assert.equal(invalidAddress.statusCode, 400);
      const response = await app.inject({ url: '/health', headers: { origin: 'https://attacker.invalid' } });
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      let status = 0;
      for (let i = 0; i < 31; i++) status = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', headers: { 'x-forwarded-for': `192.0.2.${i}` }, payload: { walletAddress: Keypair.generate().publicKey.toBase58() } })).statusCode;
      assert.equal(status, 429);
    } finally { await close(); }
  });
});

describe('execution integrity', () => {
  it('rejects forged and expired execution tickets and hashes the entire message', () => {
    const wallet = Keypair.generate(); const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    const encoded = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const intents = new ExecutionIntents('a'.repeat(32));
    const token = intents.issue({ wallet: wallet.publicKey.toBase58(), market, quote, messageHash: messageHash(encoded) });
    assert.ok(intents.read(token));
    assert.equal(intents.read(`${token.split('.')[0]}x.${token.split('.')[1]}`), null);
    assert.equal(new ExecutionIntents('b'.repeat(32)).read(token), null);
    const now = Date.now; try { Date.now = () => now() + 25 * 3600_000; assert.equal(intents.read(token), null); } finally { Date.now = now; }
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    assert.notEqual(messageHash(encoded), messageHash(tx.serialize({ requireAllSignatures: false }).toString('base64')));
  });
  it('rejects unrelated successful transactions, accepts a matching fill, and makes concurrent replay idempotent', async () => {
    const secret = process.env.EXECUTION_INTENT_SECRET;
    process.env.EXECUTION_INTENT_SECRET = 'test-only-secret-'.repeat(3);
    const wallet = Keypair.generate(); const walletAddress = wallet.publicKey.toBase58();
    const intents = new ExecutionIntents();
    const ticket = intents.issue({ wallet: walletAddress, market, quote, messageHash: 'expected-hash' });
    let hash = 'wrong-hash'; let success = true; let hasFill = true;
    const entry = (mint: string, amount: string, accountIndex: number) => ({ owner: walletAddress, mint, accountIndex, uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: amount } });
    const tx = { transaction: { message: { accountKeys: [{ pubkey: wallet.publicKey, signer: true, writable: true }], instructions: [] } }, meta: { err: null, fee: 5000, preBalances: [1e9], postBalances: [1e9 - 5000], preTokenBalances: [entry(quoteMint, '10000000', 1), entry(baseMint, '0', 2)], postTokenBalances: [entry(quoteMint, '0', 1), entry(baseMint, '5000000', 2)] } } as unknown as ParsedTransactionWithMeta;
    const receipts = new InMemoryReceiptRepository();
    const app = await createApp(provider(), receipts, previewFeePolicy, undefined, previewExecutionConfig, undefined, {
      verifyTransactionSucceeded: async () => ({ success, slot: 1, transaction: hasFill ? tx : { ...tx, meta: { ...tx.meta!, postTokenBalances: [] } } }),
      transactionMessageHash: async () => hash,
    });
    try {
      const { headers } = await login(app, wallet);
      const payload = { executionIntent: ticket, signature: '1'.repeat(88), network: 'mainnet-beta', side: 'buy', amountUsd: 10, userPublicKey: walletAddress };
      const confirm = () => app.inject({ method: 'POST', url: `/v1/markets/${market.id}/execution-confirm`, headers, payload });
      assert.equal((await confirm()).json().error.code, 'TRANSACTION_MISMATCH');
      hash = 'expected-hash'; success = false;
      assert.equal((await confirm()).json().error.code, 'TRANSACTION_NOT_VERIFIED');
      success = true; hasFill = false;
      assert.equal((await confirm()).json().error.code, 'FILL_NOT_VERIFIED');
      hasFill = true;
      const responses = await Promise.all([confirm(), confirm()]);
      assert.ok(responses.every(response => response.statusCode === 201));
      assert.equal((await receipts.list()).length, 1);
      assert.equal(responses[0].json().data.actualBaseAmount, 5);
      assert.equal(responses[0].json().data.feeStatus, 'projected');
      const other = await login(app);
      assert.deepEqual((await app.inject({ url: '/v1/execution-receipts', headers: other.headers })).json().data, []);
      assert.equal((await app.inject({ url: '/v1/execution-receipts', headers })).json().data.length, 1);
    } finally { await app.close(); if (secret === undefined) delete process.env.EXECUTION_INTENT_SECRET; else process.env.EXECUTION_INTENT_SECRET = secret; }
  });
  it('sums split token accounts and verifies native SOL output when wrapped accounts close', () => {
    const wallet = Keypair.generate().publicKey;
    const token = (mint: string, amount: string, accountIndex: number) => ({ owner: wallet.toBase58(), mint, accountIndex, uiTokenAmount: { amount, decimals: 6 } });
    const tx = { transaction: { message: { accountKeys: [{ pubkey: wallet, signer: true }], instructions: [] } }, meta: {
      err: null, fee: 5000, preBalances: [1e9, 2e6, 2e6, 2e6], postBalances: [1e9 - 5000, 2e6, 2e6, 2e6],
      preTokenBalances: [token(quoteMint, '5000000', 1), token(quoteMint, '5000000', 2), token(baseMint, '0', 3)],
      postTokenBalances: [token(quoteMint, '0', 1), token(quoteMint, '0', 2), token(baseMint, '5000000', 3)],
    } } as unknown as ParsedTransactionWithMeta;
    assert.deepEqual(extractTokenFill(tx, wallet.toBase58(), quoteMint, baseMint, 6, 6), { inputAmount: 10, outputAmount: 5 });
    tx.meta!.postTokenBalances = tx.meta!.postTokenBalances!.filter(entry => entry.mint !== baseMint);
    tx.meta!.preTokenBalances = tx.meta!.preTokenBalances!.filter(entry => entry.mint !== baseMint);
    tx.meta!.postBalances[0] = 2e9 - 5000;
    assert.deepEqual(extractTokenFill(tx, wallet.toBase58(), quoteMint, 'So11111111111111111111111111111111111111112', 6, 9), { inputAmount: 10, outputAmount: 1 });
  });
});

describe('durable receipt storage', () => {
  it('preserves concurrent writes, deduplicates signatures across restart, and refuses corrupt files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'searix-receipts-'));
    const path = join(directory, 'receipts.json');
    try {
      const repo = new FileReceiptRepository(path);
      const record = createExecutionReceipt(market, quote, { verified: true, transactionSignature: 'same-signature', network: 'mainnet-beta', walletAddress: 'owner', status: 'executed' });
      await Promise.all(Array.from({ length: 10 }, (_, i) => repo.save({ ...record, id: `attempt-${i}` })));
      assert.equal((await new FileReceiptRepository(path).list()).length, 1);
      assert.equal(executedTradesFor([record, { ...record, id: 'duplicate' }], 'owner').length, 1);
      await Promise.all(Array.from({ length: 8 }, (_, i) => repo.save({ ...record, id: `analysis-${i}`, transactionSignature: null })));
      assert.equal((await repo.list()).length, 9);
      await writeFile(path, 'corrupt');
      await assert.rejects(repo.save(record));
      assert.equal(await readFile(path, 'utf8'), 'corrupt');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
