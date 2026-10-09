import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import type { ExecutionQuote, MarketSnapshot } from './market.js';

export type ExecutionIntent = {
  wallet: string; market: MarketSnapshot; quote: ExecutionQuote;
  messageHash: string; expires: number; feeAccount?: string;
};
export function messageHash(transactionBase64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  return createHash('sha256').update(tx.message.serialize()).digest('hex');
}
export class ExecutionIntents {
  private readonly secret: Buffer;
  constructor(secret = process.env.EXECUTION_INTENT_SECRET) {
    if (secret && Buffer.byteLength(secret) < 32) throw new Error('EXECUTION_INTENT_SECRET must contain at least 32 bytes.');
    if (!secret && process.env.NODE_ENV === 'production') throw new Error('Set EXECUTION_INTENT_SECRET before production startup.');
    this.secret = secret ? Buffer.from(secret) : randomBytes(32);
  }
  issue(intent: Omit<ExecutionIntent, 'expires'>) {
    const payload = Buffer.from(JSON.stringify({ ...intent, expires: Date.now() + 24 * 60 * 60_000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.secret).update(payload).digest('base64url')}`;
  }
  read(token: string): ExecutionIntent | null {
    try {
      const parts = token.split('.'); if (parts.length !== 2) return null;
      const [payload, mac] = parts;
      const expected = createHmac('sha256', this.secret).update(payload).digest();
      const received = Buffer.from(mac, 'base64url');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
      const result = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ExecutionIntent;
      return result.expires > Date.now() ? result : null;
    } catch { return null; }
  }
}
