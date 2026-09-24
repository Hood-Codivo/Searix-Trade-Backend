# Searix Trade backend

A Fastify backend exposing a stable market-data and execution-intelligence contract, backed by a `CompositeMarketProvider`:

- **`PhoenixProvider`** — real, live Solana mainnet crypto markets, decoded directly from Phoenix CLOB accounts via `@ellipsis-labs/phoenix-sdk` (no simulation).
- **`TokenizedStockProvider`** — real tokenized-stock markets (AAPLX/TSLAX/NVDAX, backed by Backed Finance's independently-verified xStocks mints), priced from Jupiter's free public APIs. No market or field in this provider is ever seeded with placeholder data — a market only appears once a real fetch has actually populated it.

Every provider implements the same `MarketProvider` interface (`src/providers/market-provider.ts`), so the app, routes, and tests never need to know which one they're talking to.

## Run

```bash
npm install
npm test
npm run build
npm start
```

The server listens on `http://localhost:4000` by default. See `.env.example` for required configuration (Solana RPC URL, Phoenix market addresses, fee policy, receipts storage path).

## API

- `GET /health`
- `GET /v1/markets`
- `GET /v1/markets/:id`
- `GET /v1/markets/:id/orderbook`
- `GET /v1/markets/:id/candles?range=1h|1d|1w|1m`
- `GET /v1/markets/:id/quality`
- `POST /v1/markets/:id/execution-quote` — pre-trade fill/impact/fee estimate against the real book, plus a genuine routed comparison quote fetched live from Jupiter's aggregator
- `POST /v1/markets/:id/execution-receipts` — saves a tamper-evident (SHA-256 content hash), persistent analysis receipt
- `GET /v1/execution-receipts`
- `GET /v1/fees/config`
- `GET /v1/revenue/summary`
- `GET /v1/alerts` — real peg-deterioration alerts, generated when a tokenized stock's live premium crosses a threshold (150 bps watch / 300 bps warning), persisted, one alert per breach episode
- `GET /v1/registry` / `GET /v1/registry/:symbol` — verified, sourced issuer/custody/redemption/jurisdiction facts per tokenized-stock asset
- `WS /v1/stream`

The `meta.simulated` flag on `/v1/markets` and the execution-quote response distinguishes markets with a real Phoenix order book from tokenized-stock markets, whose book is a synthetic ladder (AMM tokens have no discrete book to read) generated purely from real price and real Jupiter liquidity — never a fabricated per-symbol template.

## Backend — what is finished

- Live Phoenix CLOB data: real market discovery, real decoded order books, real ranged candle history, WebSocket account-change subscriptions with a poll backstop
- Real tokenized-stock markets (AAPLX/TSLAX/NVDAX), independently verified on-chain, priced live from Jupiter (token price, real underlying-equity reference, real 24h volume/change, real liquidity) — zero API key required
- Pre-trade execution-quote engine: real book-walking math (average fill, price impact, safe size, fees) plus a real Jupiter swap-quote comparison — no fabricated venue multipliers
- Persistent, tamper-evident execution receipts (`FileReceiptRepository`, SHA-256 content hash), survive a server restart
- Fee policy, safety-gated (collection requires both an explicit opt-in and a configured treasury address)
- Peg-deterioration alerts (`PegAlertMonitor`), driven off real premium data as it arrives, persisted (`FileAlertRepository`), one alert per breach episode
- Verified tokenized-asset registry (issuer, custody, backing, redemption, jurisdiction restrictions, regulatory framework) — every field sourced from the issuer's own documentation, cited, with anything unpublished marked as such rather than invented
- Full REST + WebSocket surface, request validation, standard error contract, CORS, structured logging
- Full test suite covering the market, execution-quote, receipt, fee, revenue, alert, and registry contracts

## Backend — what is left

Live market data

- Real Phoenix fill/trade history (current volume figures for Phoenix-native crypto markets come from Jupiter's aggregate cross-DEX stats, not a Phoenix-specific fills feed)
- Historical backfilling / persisted long-range candle history (currently in-memory, rebuilt on restart)

Trading

- Wallet connection and real transaction construction/signing (MWA/Phantom/Solflare)
- Track submitted transactions and attach real signatures to receipts (`transactionSignature` is always `null` today — no trade has ever actually executed through this system)
- Order cancellation, partial-fill tracking

Production infrastructure

- Authentication, rate limiting, restricted production CORS
- Database migrations, Docker deployment, CI/CD, provider failover, secrets management, security review

## Roadmap — what would make this defensible, not just a feature

Charts, a swap button, watchlists, AI summaries, and a platform fee are all things a well-resourced competitor (Jupiter, Solflare) could reproduce quickly. These are the areas that are actually hard to copy, roughly ordered by how soon they're achievable:

1. ~~**Peg-deterioration alerts**~~ — **shipped.** `PegAlertMonitor` watches real `premiumBps` as it arrives and raises a persisted alert on threshold crossings (`GET /v1/alerts`), surfaced in the app's Alerts tab.
2. ~~**Verified tokenized-asset registry**~~ — **shipped.** Sourced issuer/custody/redemption/jurisdiction facts per asset (`GET /v1/registry`), surfaced as a card on each stock market's detail screen.
3. **Persisted real market-history archive** — today only a 31-day in-memory rolling window survives; persisting real observed spread/premium/depth over time starts a genuine longitudinal dataset before a single trade happens.
4. **Receipt hash verification endpoint** — let anyone independently confirm a saved receipt's `contentHash` wasn't altered after the fact.
5. **Real wallet execution + actual-vs-expected tracking** — the biggest lever and the biggest lift. Until real trades exist, the receipt ledger is estimates only; this is what turns it into the proprietary execution-history moat.
6. **Corporate-action monitoring** (dividends, splits, custodian changes, suspensions) — needs a verified real data source before it can be committed to; not yet researched.
