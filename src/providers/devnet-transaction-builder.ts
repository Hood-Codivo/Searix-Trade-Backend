import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

// Fixed, trivial, self-directed transfer -- exercises the real sign/submit/confirm pipeline on
// devnet without needing a counterparty or moving anything of value. Not a stand-in for a real
// trade; execution-confirm never reports a fill/price for this kind of transaction.
const PROBE_LAMPORTS = 1_000;

export type BuiltDevnetTransaction = {
  transactionBase64: string;
  lastValidBlockHeight: number;
};

export async function buildDevnetProbeTransaction(userPublicKey: string, rpcUrl: string): Promise<BuiltDevnetTransaction | null> {
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const owner = new PublicKey(userPublicKey);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const instruction = SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: PROBE_LAMPORTS });
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    return { transactionBase64: Buffer.from(transaction.serialize()).toString('base64'), lastValidBlockHeight };
  } catch {
    return null;
  }
}
