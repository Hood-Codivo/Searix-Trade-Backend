import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export type WalletTokenBalance = {
  mint: string;
  amount: number;
  decimals: number;
};

export type WalletBalances = {
  solBalance: number;
  tokens: WalletTokenBalance[];
};

// Reads a wallet's real on-chain balances: native SOL plus every token account under both the classic
// and Token-2022 programs (tokenized stocks are Token-2022). Zero-balance accounts are dropped.
export async function readWalletBalances(owner: string, rpcUrl: string): Promise<WalletBalances> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const ownerKey = new PublicKey(owner);
  const lamports = await connection.getBalance(ownerKey, 'confirmed');
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const accounts = await Promise.all(programs.map((programId) => connection.getParsedTokenAccountsByOwner(ownerKey, { programId }, 'confirmed')));
  const tokens: WalletTokenBalance[] = [];
  for (const { value } of accounts) {
    for (const account of value) {
      const info = account.account.data.parsed.info;
      const amount = Number(info.tokenAmount.uiAmount ?? 0);
      if (amount <= 0) continue;
      tokens.push({ mint: info.mint, amount, decimals: info.tokenAmount.decimals });
    }
  }
  return { solBalance: lamports / 1e9, tokens };
}
