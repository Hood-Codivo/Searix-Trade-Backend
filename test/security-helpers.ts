import { createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';

export function signMessage(wallet: Keypair, message: string) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), wallet.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(message), key).toString('base64');
}
export async function login(app: FastifyInstance, wallet = Keypair.generate()) {
  const challenge = await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { walletAddress: wallet.publicKey.toBase58() } });
  const { nonce, message } = challenge.json().data;
  const response = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { nonce, signature: signMessage(wallet, message) } });
  if (response.statusCode !== 200) throw new Error(response.body);
  return { wallet, headers: { authorization: `Bearer ${response.json().data.token}` } };
}
