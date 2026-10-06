import { Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';

export type Network = 'mainnet-beta';

export type RpcUrls = { mainnet: string };

function connectionFor(network: Network, rpcUrls: RpcUrls): Connection {
  return new Connection(rpcUrls.mainnet, 'confirmed');
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
  feeAccount?: string,
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

  // A platform fee sent to the treasury on the input mint is part of the user's spend but not of
  // the swap itself, so take it back out of the input amount the fill reports.
  const feeAtoms = feeAccount ? transferredToAccount(tx, feeAccount, inputMint) : 0;
  const swapInput = Math.abs(inputDelta) - feeAtoms / 10 ** inputDecimals;
  if (!(swapInput > 0)) return null;
  return { inputAmount: swapInput, outputAmount: outputDelta };
}

// Sums the top-level SPL transferChecked amounts (in atoms) sent to one token account for one mint.
function transferredToAccount(tx: ParsedTransactionWithMeta, destination: string, mint: string): number {
  let total = 0;
  for (const instruction of tx.transaction.message.instructions) {
    if (!('parsed' in instruction) || typeof instruction.parsed !== 'object') continue;
    const parsed = instruction.parsed as { type?: string; info?: { destination?: string; mint?: string; tokenAmount?: { amount?: string } } };
    if (parsed.type !== 'transferChecked') continue;
    if (parsed.info?.destination !== destination || parsed.info?.mint !== mint) continue;
    total += Number(parsed.info.tokenAmount?.amount ?? 0);
  }
  return total;
}
