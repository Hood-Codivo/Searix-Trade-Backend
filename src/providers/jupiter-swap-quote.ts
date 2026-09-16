// Real, live-verified Jupiter aggregator endpoints -- no API key. Used to get a genuine routed
// comparison price for the execution-quote feature, replacing what used to be a fabricated
// "Jupiter" multiplier.
const SWAP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Returns the raw output-token atom amount for a real swap of `inputAtoms` of inputMint into
// outputMint, or null if the quote fails for any reason (no live route, network error, etc.) --
// callers should degrade to omitting the comparison rather than fabricate one.
export async function fetchJupiterSwapQuote(inputMint: string, outputMint: string, inputAtoms: string): Promise<{ outAmount: number } | null> {
  try {
    const query = new URLSearchParams({ inputMint, outputMint, amount: inputAtoms, slippageBps: '50' });
    const response = await fetch(`${SWAP_QUOTE_URL}?${query}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { outAmount?: string };
    const outAmount = Number(payload.outAmount);
    return Number.isFinite(outAmount) && outAmount > 0 ? { outAmount } : null;
  } catch {
    return null;
  }
}
