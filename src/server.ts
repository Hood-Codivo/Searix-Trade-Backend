import { createApp } from "./app.js";
import { feePolicyFromEnvironment } from "./domain/fee-policy.js";
import { FileReceiptRepository } from "./domain/receipt-repository.js";
import { FileAlertRepository } from "./domain/alert-repository.js";
import { CompositeMarketProvider } from "./providers/composite-market-provider.js";
import type { MarketProvider } from "./providers/market-provider.js";
import { PegAlertMonitor } from "./providers/peg-alert-monitor.js";
import { PhoenixProvider } from "./providers/phoenix-provider.js";
import { TokenizedStockProvider } from "./providers/tokenized-stock-provider.js";

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
  const phoenixProvider = new PhoenixProvider({ rpcUrl, wsUrl, marketAddresses });
  const stockProvider = new TokenizedStockProvider();
  return new CompositeMarketProvider([phoenixProvider, stockProvider]);
}

const provider = buildProvider();
const receipts = new FileReceiptRepository(process.env.RECEIPTS_FILE_PATH ?? "data/receipts.json");
const alerts = new FileAlertRepository(process.env.ALERTS_FILE_PATH ?? "data/alerts.json");
const app = await createApp(provider, receipts, feePolicyFromEnvironment(), alerts);

const pegAlertMonitor = new PegAlertMonitor(provider, alerts);
pegAlertMonitor.start();
app.addHook("onClose", async () => pegAlertMonitor.stop());

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
