import { Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';

export type Network = 'devnet' | 'mainnet-beta';

export type RpcUrls = { devnet: string; mainnet: string };

function connectionFor(network: Network, rpcUrls: RpcUrls): Connection {
  return new Connection(network === 'devnet' ? rpcUrls.devnet : rpcUrls.mainnet, 'confirmed');
}

export type VerifiedTransaction = {
  success: boolean;
  slot: number | null;
  transaction: ParsedTransactionWithMeta | null;
};

// The only source of truth for whether an execution actually happened -- fetches the transaction
// from the real chain and confirms it succeeded. Never trusts a client's claim that a signature is
// valid; a signature that doesn't resolve, or resolved with an on-chain error, is not verified.
export async function verifyTransactionSucceeded(signature: string, network: Network, rpcUrls: RpcUrls): Promise<VerifiedTransaction> {
  try {
    const connection = connectionFor(network, rpcUrls);
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx || tx.meta?.err) return { success: false, slot: null, transaction: null };
    return { success: true, slot: tx.slot, transaction: tx };
  } catch {
    return { success: false, slot: null, transaction: null };
  }
}

// Best-effort: extracts the real spent/received amounts for a token swap from the confirmed
// transaction's own balance deltas. Returns null on any mismatch or unexpected shape rather than
// guess -- callers should leave the receipt's actual-amount fields null in that case, not fabricate
// a number, matching the honesty requirement for every other real-data path in this project.
export function extractTokenFill(
  tx: ParsedTransactionWithMeta,
  ownerAddress: string,
  inputMint: string,
  outputMint: string,
  inputDecimals: number,
  outputDecimals: number,
): { inputAmount: number; outputAmount: number } | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const delta = (mint: string, decimals: number): number => {
    const preEntry = pre.find((b) => b.owner === ownerAddress && b.mint === mint);
    const postEntry = post.find((b) => b.owner === ownerAddress && b.mint === mint);
    const preAtoms = preEntry ? Number(preEntry.uiTokenAmount.amount) : 0;
    const postAtoms = postEntry ? Number(postEntry.uiTokenAmount.amount) : 0;
    return (postAtoms - preAtoms) / 10 ** decimals;
  };

  const inputDelta = delta(inputMint, inputDecimals);
  const outputDelta = delta(outputMint, outputDecimals);
  if (!(inputDelta < 0) || !(outputDelta > 0)) return null;
  return { inputAmount: Math.abs(inputDelta), outputAmount: outputDelta };
}
