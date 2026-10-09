import { createHash } from 'node:crypto';
import { TransactionMessage, type Connection, type VersionedMessage } from '@solana/web3.js';

// Solana's native compute-budget program: sets priority fee / compute unit limits only. It can never
// move funds, change an account's owner, or touch anyone's tokens -- by the program's own design, not
// just by convention -- so excluding it from the hash can't open a path for a swapped trade to pass.
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

// Hashes everything about a transaction's instructions except its recentBlockhash and any compute-budget
// instructions. A wallet refreshing an about-to-expire blockhash, or adding/adjusting a priority fee,
// before signing is normal, safe, automatic wallet behavior -- neither should look like tampering. A
// changed account, amount, program, or any other instruction must still change this hash.
export async function canonicalMessageHash(message: VersionedMessage, connection: Connection): Promise<string> {
  const tables = await Promise.all(message.addressTableLookups.map(async (lookup) => {
    const result = await connection.getAddressLookupTable(lookup.accountKey);
    if (!result.value) throw new Error('Address lookup table is unavailable.');
    return result.value;
  }));
  const decompiled = TransactionMessage.decompile(message, { addressLookupTableAccounts: tables });
  const canonical = JSON.stringify({
    payer: decompiled.payerKey.toBase58(),
    instructions: decompiled.instructions
      .filter((instruction) => instruction.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM)
      .map((instruction) => ({
        programId: instruction.programId.toBase58(),
        keys: instruction.keys.map((key) => ({ pubkey: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })),
        data: Buffer.from(instruction.data).toString('base64'),
      })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
