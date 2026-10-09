// Generates a new payer keypair for one-time setup transactions (e.g. the treasury token accounts).
// Writes it to secrets/ (git-ignored) with owner-only permissions and prints only the public address.
// Refuses to overwrite an existing keypair, so a funded wallet can't be replaced by accident.
import { existsSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

const path = process.argv[2] ?? 'secrets/payer-keypair.json';
if (existsSync(path)) {
  console.log(`Refusing to overwrite existing keypair at ${path}.`);
  process.exit(1);
}
const keypair = Keypair.generate();
writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: 'wx' });
console.log(`Keypair written to ${path}`);
console.log(`Public address: ${keypair.publicKey.toBase58()}`);
