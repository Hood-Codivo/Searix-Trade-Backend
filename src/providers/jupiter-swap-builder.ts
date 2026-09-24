import type { JupiterQuoteResponse } from './jupiter-swap-quote.js';

const SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

export type BuiltSwapTransaction = {
  transactionBase64: string;
  lastValidBlockHeight: number;
};

// Builds a real, unsigned swap transaction from a quote. Never signs anything -- returns base64
// for the caller to hand to the user's own wallet. `feeAccount` (a real token account owned by the
// treasury, for the input or output mint) is how Jupiter routes the platform fee set on the quote.
export async function buildJupiterSwapTransaction(params: {
  quoteResponse: JupiterQuoteResponse;
  userPublicKey: string;
  feeAccount?: string;
}): Promise<BuiltSwapTransaction | null> {
  try {
    const body: Record<string, unknown> = {
      userPublicKey: params.userPublicKey,
      quoteResponse: params.quoteResponse,
      dynamicComputeUnitLimit: true,
    };
    if (params.feeAccount) body.feeAccount = params.feeAccount;

    const response = await fetch(SWAP_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { swapTransaction?: string; lastValidBlockHeight?: number };
    if (!payload.swapTransaction || typeof payload.lastValidBlockHeight !== 'number') return null;
    return { transactionBase64: payload.swapTransaction, lastValidBlockHeight: payload.lastValidBlockHeight };
  } catch {
    return null;
  }
}
