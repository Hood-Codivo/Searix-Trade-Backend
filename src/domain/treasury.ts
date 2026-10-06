import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { assetRegistry } from './registry.js';

// Tokenized stocks are Token-2022 mints, so their treasury accounts derive under that program, not the
// classic SPL token program. The registry records which program each mint uses; anything not in it is classic.
function tokenProgramForMint(mint: string): PublicKey {
  const entry = assetRegistry.find((registered) => registered.mint === mint);
  return entry ? new PublicKey(entry.tokenProgram) : TOKEN_PROGRAM_ID;
}

// Derives the treasury's associated token account for a given mint -- this is the `feeAccount`
// Jupiter routes the platform fee into. Uses the real, well-tested SPL derivation rather than
// hand-rolled PDA math, since this address is where real money would actually go.
// The account must exist on-chain already (a one-time setup step at mainnet go-live);
// this function only derives the address, it does not create anything.
export function deriveTreasuryFeeAccount(treasuryAddress: string, mint: string): string {
  const owner = new PublicKey(treasuryAddress);
  const mintKey = new PublicKey(mint);
  return getAssociatedTokenAddressSync(mintKey, owner, false, tokenProgramForMint(mint)).toBase58();
}

export { tokenProgramForMint };
