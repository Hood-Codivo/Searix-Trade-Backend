const HERMES_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

export type PythPricePoint = { price: number; confidence: number; publishTime: number };

export type PythFetchResult = {
  prices: Map<string, PythPricePoint>;
  // False whenever the grant doesn't cover the requested feeds (verified live: Hermes returns a
  // whole-batch 403 "not entitled" for equity/xStock feeds on a free-tier key, while plain crypto
  // majors return real data on the same key). Distinguishing this from a transient error lets
  // callers show an honest "pending access" state instead of a generic failure.
  entitled: boolean;
};

// Real Hermes pull-oracle endpoint. Degrades to an explicit not-entitled/unavailable signal rather
// than fabricating a price -- once a feed grant is approved, this starts returning real parsed
// prices with no code change on our side.
export async function fetchPythPrices(feedIds: string[], apiKey: string | undefined): Promise<PythFetchResult> {
  if (!apiKey || feedIds.length === 0) return { prices: new Map(), entitled: false };
  try {
    const query = feedIds.map((id) => `ids[]=${id}`).join('&');
    const response = await fetch(`${HERMES_URL}?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return { prices: new Map(), entitled: false };

    const payload = await response.json() as {
      parsed?: Array<{ id: string; price: { price: string; expo: number; conf: string; publish_time: number } }>;
    };
    const prices = new Map<string, PythPricePoint>();
    for (const item of payload.parsed ?? []) {
      const price = Number(item.price.price) * 10 ** item.price.expo;
      const confidence = Number(item.price.conf) * 10 ** item.price.expo;
      if (Number.isFinite(price) && price > 0) {
        prices.set(item.id, { price, confidence, publishTime: item.price.publish_time });
      }
    }
    return { prices, entitled: true };
  } catch {
    return { prices: new Map(), entitled: false };
  }
}
