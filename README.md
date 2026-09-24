# Searix Trade backend

A Fastify + TypeScript backend for Searix Trade, a mobile trading companion for Solana on-chain
order-book markets. It exposes real market data, a pre-trade execution-quote engine, real order
execution (wallet-signed, on-chain verified), and the platform's fee/receipt/alert/registry
surfaces — no simulated data anywhere in the response contract.

## Tech stack

- **Runtime**: Node.js (ESM, `NodeNext` module resolution), TypeScript, [Fastify](https://fastify.dev/) (`@fastify/cors`, `@fastify/websocket`)
- **Validation**: [zod](https://zod.dev/) on every request body/params
- **Solana**: `@solana/web3.js`, `@solana/spl-token` (treasury ATA derivation), `@ellipsis-labs/phoenix-sdk` (real Phoenix CLOB account decoding)
- **Persistence** (each optional, degrades gracefully when unset):
  - **Postgres** (`pg`) — execution receipts and peg alerts, survives a redeploy; auto-migrates any leftover file-backed records on first boot. Falls back to a local JSON file when `DATABASE_URL` is unset.
  - **ClickHouse** (`@clickhouse/client`) — real tick-by-tick price history (`market_ticks`, `MergeTree`), auto-creates its database/table on first boot. Recording is a fire-and-forget no-op when `CLICKHOUSE_URL` is unset.
  - **Redis** (`ioredis`) — short-TTL (15s) cache-aside in front of the two Jupiter API calls, with graceful fallback to a live fetch on any cache miss or Redis error. No-op when `REDIS_URL` is unset.
- **External data/execution APIs** (all real, no fabricated fallback data):
  - Solana mainnet + devnet RPC (market decoding, transaction verification)
  - Jupiter `price/v3`, `tokens/v2/search`, `swap/v1/quote`, `swap/v1/swap` (routed quotes, real swap-transaction building)
  - Pyth Hermes (`hermes.pyth.network`) — real equity + xStock cross-check feeds (gated behind a feed-grant; degrades to an honest "pending" state until granted, never fabricated)

## Architecture

Every market source implements the same `MarketProvider` interface (`src/providers/market-provider.ts`), combined via `CompositeMarketProvider`, so the app/routes/tests never need to know which one they're talking to:

- **`PhoenixProvider`** — real, live Solana mainnet crypto markets, decoded directly from Phoenix CLOB accounts (no simulation).
- **`TokenizedStockProvider`** — real tokenized-stock markets (AAPLX/TSLAX/NVDAX, Backed Finance's independently-verified xStocks mints), priced from Jupiter's free public APIs, cross-checked against Pyth. No market or field is ever seeded with placeholder data — a market only appears once a real fetch has actually populated it.

## Run

```bash
npm install
npm test
npm run build
npm start
```

The server listens on `http://localhost:4000` by default. Copy `.env.example` to `.env` and fill
in real values — see the comments in that file for what each variable does and which ones are
optional. At minimum you need `SOLANA_RPC_URL` and `PHOENIX_MARKET_IDS` for live crypto markets.

**Trading**

- Order cancellation, partial-fill tracking
- A Phoenix-specific fills/trade-history feed (current volume for Phoenix-native crypto markets comes from Jupiter's aggregate cross-DEX stats, not a Phoenix-native fills stream)

**Production infrastructure**

- Authentication, rate limiting, a restricted production CORS allowlist (currently allows all origins)
- Receipt hash verification endpoint (let anyone independently confirm a saved receipt's `contentHash` wasn't altered after the fact)
- CI/CD, provider failover, secrets management, a full security review
- Corporate-action monitoring (dividends, splits, custodian changes, suspensions) — needs a verified real data source before it can be committed to; not yet researched
