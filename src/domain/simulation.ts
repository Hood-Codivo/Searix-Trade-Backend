import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

export type SimulationResult =
  | { ok: true }
  | { ok: false; reason: string };

// Simulates an unsigned transaction on mainnet before it is handed to a wallet. A wallet can only say
// "unknown error" for a transaction that fails, so the real reason is pulled from the program logs here.
// Accepts both legacy and versioned transactions, since Jupiter returns the latter.
export async function simulateBeforeSigning(transactionBase64: string, rpcUrl: string): Promise<SimulationResult> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const raw = Buffer.from(transactionBase64, 'base64');
  const simulation = await (async () => {
    try {
      return await connection.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: false, replaceRecentBlockhash: true });
    } catch {
      return connection.simulateTransaction(Transaction.from(raw), undefined, false);
    }
  })();
  if (!simulation.value.err) return { ok: true };

  const logs = simulation.value.logs ?? [];
  // Prefer the most specific line (e.g. 'insufficient lamports') over the outer 'Program X failed' line.
  const failureLine = logs.find((line) => /insufficient/i.test(line)) ?? [...logs].reverse().find((line) => /failed|error/i.test(line));
  const reason = failureLine
    ? failureLine.replace(/^Program log:\s*/, '').trim()
    : `Simulation failed: ${JSON.stringify(simulation.value.err)}`;
  return { ok: false, reason };
}

// Checks the wallet holds enough of the token it is spending before any transaction is built, so a
// shortfall is reported as a plain balance message rather than a program error. Returns null when it can pay.
export async function shortfallFor(owner: string, mint: string, symbol: string, amountAtoms: bigint, decimals: number, rpcUrl: string, tokenProgram: PublicKey): Promise<string | null> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, tokenProgram);
  const balance = await connection.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
  if (balance >= amountAtoms) return null;
  const format = (atoms: bigint) => (Number(atoms) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals });
  return `this wallet holds ${format(balance)} ${symbol}, but the order needs ${format(amountAtoms)} ${symbol}.`;
}
