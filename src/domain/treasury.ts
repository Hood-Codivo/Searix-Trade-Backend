import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

// Derives the treasury's associated token account for a given mint -- this is the `feeAccount`
// Jupiter routes the platform fee into. Uses the real, well-tested SPL derivation rather than
// hand-rolled PDA math, since this address is where real money would actually go.
// The account must exist on-chain already (a one-time setup step at mainnet go-live);
// this function only derives the address, it does not create anything.
export function deriveTreasuryFeeAccount(treasuryAddress: string, mint: string): string {
  const owner = new PublicKey(treasuryAddress);
  const mintKey = new PublicKey(mint);
  return getAssociatedTokenAddressSync(mintKey, owner).toBase58();
}
