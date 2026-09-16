import { createApp } from "./app.js";
import type { MarketProvider } from "./providers/market-provider.js";
import { PhoenixProvider } from "./providers/phoenix-provider.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

function buildProvider(): MarketProvider {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const marketAddresses = process.env.PHOENIX_MARKET_IDS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!rpcUrl || !marketAddresses?.length) {
    throw new Error(
      "MARKET_PROVIDER=phoenix requires SOLANA_RPC_URL and PHOENIX_MARKET_IDS to be set.",
    );
  }
  const wsUrl = process.env.SOLANA_WS_URL?.includes("YOUR_KEY")
    ? undefined
    : process.env.SOLANA_WS_URL;
  return new PhoenixProvider({ rpcUrl, wsUrl, marketAddresses });
}

const provider = buildProvider();
const app = await createApp(provider);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
