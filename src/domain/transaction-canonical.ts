import { createHash } from 'node:crypto';
import { TransactionMessage, type Connection, type VersionedMessage } from '@solana/web3.js';

// Hashes everything about a transaction's instructions except its recentBlockhash. A wallet refreshing
// an about-to-expire blockhash before signing is normal, safe behavior -- it must not look like
// tampering. A changed account, amount, program, or instruction must still change this hash: that's
// still exactly the kind of substitution this check exists to catch.
export async function canonicalMessageHash(message: VersionedMessage, connection: Connection): Promise<string> {
  const tables = await Promise.all(message.addressTableLookups.map(async (lookup) => {
    const result = await connection.getAddressLookupTable(lookup.accountKey);
    if (!result.value) throw new Error('Address lookup table is unavailable.');
    return result.value;
  }));
  const decompiled = TransactionMessage.decompile(message, { addressLookupTableAccounts: tables });
  const canonical = JSON.stringify({
    payer: decompiled.payerKey.toBase58(),
    instructions: decompiled.instructions.map((instruction) => ({
      programId: instruction.programId.toBase58(),
      keys: instruction.keys.map((key) => ({ pubkey: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })),
      data: Buffer.from(instruction.data).toString('base64'),
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
