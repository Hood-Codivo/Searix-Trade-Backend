import { createApp } from "./app.js";
import { feePolicyFromEnvironment } from "./domain/fee-policy.js";
import { executionConfigFromEnvironment } from "./domain/execution-config.js";
import { isDatabaseConfigured } from "./domain/db.js";
import { FileReceiptRepository, type ReceiptRepository } from "./domain/receipt-repository.js";
import { FileAlertRepository, type AlertRepository } from "./domain/alert-repository.js";
import { PostgresReceiptRepository } from "./domain/postgres-receipt-repository.js";
import { PostgresAlertRepository } from "./domain/postgres-alert-repository.js";
import { CompositeMarketProvider } from "./providers/composite-market-provider.js";
import type { MarketProvider } from "./providers/market-provider.js";
import { PegAlertMonitor } from "./providers/peg-alert-monitor.js";
import { AlertRuleMonitor, FileAlertRuleStore } from "./domain/alert-rules.js";
import { FilePushTokenStore } from "./domain/push-tokens.js";
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
  const stockProvider = new TokenizedStockProvider(20_000, true, undefined, process.env.PYTH_API_KEY);
  return new CompositeMarketProvider([phoenixProvider, stockProvider]);
}

const provider = buildProvider();
const receiptsFilePath = process.env.RECEIPTS_FILE_PATH ?? "data/receipts.json";
const alertsFilePath = process.env.ALERTS_FILE_PATH ?? "data/alerts.json";
// Postgres survives a Render redeploy; the file-backed repositories don't (ephemeral filesystem).
// Falls back to file storage when DATABASE_URL isn't set, e.g. local dev without a database.
const receipts: ReceiptRepository = isDatabaseConfigured()
  ? new PostgresReceiptRepository(receiptsFilePath)
  : new FileReceiptRepository(receiptsFilePath);
const alerts: AlertRepository = isDatabaseConfigured()
  ? new PostgresAlertRepository(alertsFilePath)
  : new FileAlertRepository(alertsFilePath);
const alertRules = new FileAlertRuleStore("data/alert-rules.json");
const pushTokens = new FilePushTokenStore("data/push-tokens.json");
// Shares one pushTokens instance with the monitor below -- a separate instance would cache its own
// (possibly empty) copy of the file and never see a token registered through the API.
const app = await createApp(provider, receipts, feePolicyFromEnvironment(), alerts, executionConfigFromEnvironment(), alertRules, undefined, pushTokens);

const pegAlertMonitor = new PegAlertMonitor(provider, alerts);
pegAlertMonitor.start();
const alertRuleMonitor = new AlertRuleMonitor(provider, alertRules, alerts, pushTokens);
alertRuleMonitor.start();
app.addHook("onClose", async () => { pegAlertMonitor.stop(); alertRuleMonitor.stop(); });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
