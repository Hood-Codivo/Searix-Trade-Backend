// One-time setup: creates the treasury's associated token accounts for every token the Jupiter route
// can buy, so platform fees can land on buys. Jupiter's API cannot create these itself.
//
// Usage (run from the project root, after `npm run build`):
//   SOLANA_RPC_URL=... PHOENIX_TREASURY_ADDRESS=... PAYER_KEYPAIR=/path/to/keypair.json \
//     node --env-file=.env scripts/create-treasury-token-accounts.mjs          # build + simulate only
//     ... same command with --send                                             # submit on mainnet
//
// The payer pays rent (a small amount of SOL per account). The treasury does not need to sign.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { PhoenixProvider } from '../dist/src/providers/phoenix-provider.js';
import { assetRegistry } from '../dist/src/domain/registry.js';
import { tokenProgramForMint } from '../dist/src/domain/treasury.js';

const rpcUrl = process.env.SOLANA_RPC_URL;
const treasury = new PublicKey(process.env.PHOENIX_TREASURY_ADDRESS);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, 'utf8'))));
const send = process.argv.includes('--send');
const connection = new Connection(rpcUrl, 'confirmed');

// Every token the Jupiter route can buy: wrapped SOL, the tokenized stocks, and each Phoenix market's base mint.
const mints = new Map([[NATIVE_MINT.toBase58(), 'SOL']]);
for (const entry of assetRegistry) mints.set(entry.mint, entry.symbol);
const phoenixIds = (process.env.PHOENIX_MARKET_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const phoenix = new PhoenixProvider({ rpcUrl, marketAddresses: phoenixIds });
await phoenix.start();
for (const market of phoenix.list()) if (market.baseMint) mints.set(market.baseMint, market.base);
await phoenix.stop();

// Solana caps a transaction's size, so the accounts are created in batches of six.
const BATCH = 6;
const missing = [];
for (const [mint, symbol] of mints) {
  const mintKey = new PublicKey(mint);
  const programId = tokenProgramForMint(mint);
  const ata = getAssociatedTokenAddressSync(mintKey, treasury, true, programId);
  if (await connection.getAccountInfo(ata)) { console.log(`exists  ${symbol.padEnd(8)} ${ata.toBase58()}`); continue; }
  missing.push({ mintKey, ata, symbol, programId });
}
if (missing.length === 0) { console.log('All treasury token accounts already exist.'); process.exit(0); }

let failed = false;
for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH);
  const transaction = new Transaction();
  for (const { mintKey, ata, symbol, programId } of batch) {
    console.log(`create  ${symbol.padEnd(8)} ${ata.toBase58()}`);
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, treasury, mintKey, programId));
  }
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  transaction.partialSign(payer);
  const simulation = await connection.simulateTransaction(transaction, undefined, false);
  console.log(`batch ${i / BATCH + 1}: simulation ${simulation.value.err ? 'FAIL ' + JSON.stringify(simulation.value.err) : 'PASS'}`);
  if (simulation.value.err) { failed = true; break; }
  if (send) {
    const signature = await sendAndConfirmTransaction(connection, transaction, [payer], { commitment: 'confirmed' });
    console.log('submitted:', signature);
  }
}
if (!send) console.log(failed ? 'Dry run failed.' : 'Dry run passed. Re-run with --send to submit.');
process.exit(failed ? 1 : 0);
