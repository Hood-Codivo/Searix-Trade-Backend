import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const addressSchema = z.string().min(32).max(44).refine((value) => {
  if (value.length < 32 || value.length > 44) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}, 'Invalid Solana address');

declare module 'fastify' { interface FastifyRequest { walletAddress: string | null } }

// Bounded single-process sessions. Restarting invalidates sessions; clients sign in again.
// Multiple replicas require sticky routing or a shared atomic session/challenge store.
export async function registerSecurity(app: FastifyInstance) {
  const challenges = new Map<string, { wallet: string; message: string; expires: number }>();
  const sessions = new Map<string, { wallet: string; expires: number }>();
  const buckets = new Map<string, { count: number; expires: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const map of [challenges, sessions, buckets]) for (const [key, value] of map) if (value.expires <= now) map.delete(key);
  };
  const timer = setInterval(sweep, 30_000); timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); challenges.clear(); sessions.clear(); buckets.clear(); });
  app.decorateRequest('walletAddress', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    const now = Date.now();
    // Do not trust arbitrary X-Forwarded-For headers. Configure only trusted proxy IPs.
    const key = request.ip;
    let bucket = buckets.get(key);
    if (!bucket || bucket.expires <= now) {
      if (buckets.size >= 10_000) { sweep(); if (buckets.size >= 10_000) return reply.code(503).send({ error: { code: 'BUSY', message: 'Please try again shortly.' } }); }
      bucket = { count: 0, expires: now + 60_000 }; buckets.set(key, bucket);
    }
    const cost = request.url.startsWith('/v1/auth/') ? 10 : request.method === 'GET' ? 1 : 5;
    bucket.count += cost;
    if (bucket.count > 300) return reply.header('Retry-After', Math.ceil((bucket.expires - now) / 1000)).code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' } });
    const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (session && session.expires > now) request.walletAddress = session.wallet;
  });
  app.addHook('preHandler', async (request, reply) => {
    const path = request.routeOptions.url ?? '';
    const privateRoute = path.startsWith('/v1/alert-rules') || path.startsWith('/v1/wallets/') ||
      path === '/v1/execution-receipts' || /\/execution-(receipts|transaction|confirm)$/.test(path) ||
      (path === '/v1/alerts' && Boolean((request.query as { wallet?: unknown }).wallet));
    if (!privateRoute) return;
    if (!request.walletAddress) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Sign in with your wallet to continue.' } });
    const params = request.params as { address?: string };
    const query = request.query as { wallet?: string };
    const body = request.body as { walletAddress?: string; userPublicKey?: string } | undefined;
    for (const claimed of [params.address, query.wallet, body?.walletAddress, body?.userPublicKey]) {
      if (claimed !== undefined && claimed !== request.walletAddress) return reply.code(403).send({ error: { code: 'WALLET_MISMATCH', message: 'This request belongs to another wallet.' } });
    }
  });
  app.post('/v1/auth/challenge', async (request, reply) => {
    const parsed = z.object({ walletAddress: addressSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_WALLET_ADDRESS', message: 'Provide a valid wallet address.' } });
    sweep();
    if (challenges.size >= 5000) return reply.code(503).send({ error: { code: 'BUSY', message: 'Please try again shortly.' } });
    const nonce = randomBytes(32).toString('hex');
    const expires = Date.now() + 5 * 60_000;
    const message = `Searix Trade wallet sign-in\nWallet: ${parsed.data.walletAddress}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nThis message authenticates your account. It does not authorize a transaction.`;
    challenges.set(nonce, { wallet: parsed.data.walletAddress, message, expires });
    return { data: { nonce, message, expiresAt: new Date(expires).toISOString() } };
  });
  app.post('/v1/auth/session', async (request, reply) => {
    const parsed = z.object({ nonce: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(100) }).safeParse(request.body);
    const challenge = parsed.success ? challenges.get(parsed.data.nonce) : undefined;
    if (!parsed.success || !challenge || challenge.expires <= Date.now()) return reply.code(401).send({ error: { code: 'INVALID_CHALLENGE', message: 'Sign-in expired. Please try again.' } });
    // Consume before verification, including failed attempts: one signature attempt per nonce.
    challenges.delete(parsed.data.nonce);
    const signature = Buffer.from(parsed.data.signature, 'base64');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(challenge.wallet).toBuffer()]), format: 'der', type: 'spki' });
    if (signature.length !== 64 || !verify(null, Buffer.from(challenge.message), key, signature)) return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Wallet signature did not match.' } });
    sweep();
    if (sessions.size >= 10_000) return reply.code(503).send({ error: { code: 'BUSY', message: 'Please try again shortly.' } });
    const token = randomBytes(32).toString('hex'); const expires = Date.now() + 60 * 60_000;
    sessions.set(token, { wallet: challenge.wallet, expires });
    return { data: { token, walletAddress: challenge.wallet, expiresAt: expires } };
  });
  app.delete('/v1/auth/session', async (request) => {
    const token = request.headers.authorization?.slice(7); if (token) sessions.delete(token);
    return { data: { removed: true } };
  });
}

export function ownReceipts<T extends { walletAddress: string | null }>(rows: T[], request: FastifyRequest) {
  return rows.filter(row => row.walletAddress === request.walletAddress);
}
export function page<T>(rows: T[], query: unknown): T[] {
  const parsed = z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(query);
  const { offset, limit } = parsed.success ? parsed.data : { offset: 0, limit: 100 };
  return rows.slice(offset, offset + limit);
}
