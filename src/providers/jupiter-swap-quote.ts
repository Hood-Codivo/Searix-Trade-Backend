// Real, live-verified Jupiter aggregator endpoints -- no API key. Used both for the informational
// venue-comparison quote (execution-quote) and, with platformFeeBps set, for building a real
// executable swap transaction (execution-transaction).
const SWAP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type JupiterQuoteResponse = Record<string, unknown> & { outAmount?: string };

// Returns the output-token atom amount plus the full raw quote object (needed verbatim by
// /swap/v1/swap to build a real transaction), or null if the quote fails for any reason (no live
// route, network error, etc.) -- callers should degrade rather than fabricate a result.
export async function fetchJupiterSwapQuote(
  inputMint: string,
  outputMint: string,
  inputAtoms: string,
  platformFeeBps?: number,
): Promise<{ outAmount: number; raw: JupiterQuoteResponse } | null> {
  try {
    const params: Record<string, string> = { inputMint, outputMint, amount: inputAtoms, slippageBps: '50' };
    if (platformFeeBps && platformFeeBps > 0) params.platformFeeBps = String(platformFeeBps);
    const query = new URLSearchParams(params);
    const response = await fetch(`${SWAP_QUOTE_URL}?${query}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as JupiterQuoteResponse;
    const outAmount = Number(payload.outAmount);
    return Number.isFinite(outAmount) && outAmount > 0 ? { outAmount, raw: payload } : null;
  } catch {
    return null;
  }
}
