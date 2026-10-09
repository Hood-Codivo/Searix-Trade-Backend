import { createHash } from 'node:crypto';
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
    if (!tx || !tx.meta || tx.meta.err !== null) return { success: false, slot: null, transaction: null };
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

  const nativeMint = 'So11111111111111111111111111111111111111112';
  const nativeChange = () => {
    const ownerIndex = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.toBase58() === ownerAddress);
    if (ownerIndex < 0 || !tx.meta) return 0;
    let lamports = (tx.meta.postBalances[ownerIndex] ?? 0) - (tx.meta.preBalances[ownerIndex] ?? 0);
    if (ownerIndex === 0) lamports += tx.meta.fee;
    // Normalize token-account rent, including temporary wrapped-SOL accounts that are closed.
    for (const index of new Set([...pre, ...post].map(entry => entry.accountIndex))) {
      const before = pre.find(entry => entry.accountIndex === index);
      const after = post.find(entry => entry.accountIndex === index);
      const preRent = before ? (tx.meta.preBalances[index] ?? 0) - (before.mint === nativeMint ? Number(before.uiTokenAmount.amount) : 0) : 0;
      const postRent = after ? (tx.meta.postBalances[index] ?? 0) - (after.mint === nativeMint ? Number(after.uiTokenAmount.amount) : 0) : 0;
      lamports += postRent - preRent;
    }
    return lamports / 1e9;
  };
  const delta = (mint: string, decimals: number): number => {
    const sum = (entries: typeof pre) => entries.filter(b => b.owner === ownerAddress && b.mint === mint)
      .reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
    const change = sum(post) - sum(pre);
    if (change > BigInt(Number.MAX_SAFE_INTEGER) || change < -BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
    return Number(change) / 10 ** decimals + (mint === nativeMint ? nativeChange() : 0);
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
export function transferredToAccount(tx: ParsedTransactionWithMeta, destination: string, mint: string): number {
  let total = 0;
  for (const instruction of [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions)]) {
    if (!('parsed' in instruction) || typeof instruction.parsed !== 'object') continue;
    const parsed = instruction.parsed as { type?: string; info?: { destination?: string; mint?: string; tokenAmount?: { amount?: string } } };
    if (parsed.type !== 'transferChecked') continue;
    if (parsed.info?.destination !== destination || parsed.info?.mint !== mint) continue;
    total += Number(parsed.info.tokenAmount?.amount ?? 0);
  }
  return total;
}

export async function transactionMessageHash(signature: string, rpcUrls: RpcUrls): Promise<string | null> {
  try {
    const tx = await new Connection(rpcUrls.mainnet, 'confirmed').getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta || tx.meta.err !== null) return null;
    return createHash('sha256').update(tx.transaction.message.serialize()).digest('hex');
  } catch { return null; }
}
