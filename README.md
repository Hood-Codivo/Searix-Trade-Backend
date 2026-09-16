# Phoenix Lens backend

The backend exposes a stable market-data contract and a WebSocket stream. It currently uses `SimulatedPhoenixProvider` for deterministic local development. A live Phoenix implementation will conform to the same `MarketProvider` interface.

## Run

```powershell
npm install
npm test
npm run build
npm start
```

The server listens on `http://localhost:4000` by default.

## API

- `GET /health`
- `GET /v1/markets`
- `GET /v1/markets/:id`
- `GET /v1/markets/:id/orderbook`
- `GET /v1/markets/:id/candles`
- `GET /v1/markets/:id/quality`
- `WS /v1/stream`

The `meta.simulated` response flag prevents preview data from being mistaken for live trading data.

Backend — what is finished

- Separate Fastify backend application
- REST API structure
- WebSocket endpoint
- Health endpoint
- Markets endpoint
- Individual market endpoint
- Order-book endpoint
- Candles endpoint
- Quality-score endpoint
- Request validation
- Standard error responses
- CORS support
- Simulated updating Phoenix provider
- Market-provider interface
- Spread, depth-imbalance and preview quality calculations
- Four passing API tests

Backend — what is left
Live market data

- Choose Phoenix Legacy spot or Phoenix perpetuals/Rise
- Integrate the correct Phoenix SDK
- Connect Helius or another Solana RPC provider
- Subscribe to market accounts and transactions
- Decode real orders and fills
- Reconstruct live order books
- Detect missing updates using sequence or slot numbers
- Recover data after network disconnections
- Reconcile reconstructed books with RPC snapshots

Data and analytics

- Produce real OHLCV candles
- Calculate actual 24-hour volume
- Calculate executable depth
- Calculate expected slippage for different order sizes
- Store raw fills and order-book snapshots
- Add PostgreSQL for application data
- Add ClickHouse for historical market analytics
- Add Redis for current market state and caching
- Implement fairness-pattern analysis
- Version and audit scoring calculations
- Add historical backfilling

Trading

- Build Phoenix limit-order instructions
- Build market-order instructions
- Simulate transactions
- Estimate network and priority fees
- Validate token accounts and balances
- Track submitted transactions
- Track partial and complete fills
- Support order cancellation
- Verify any referral or revenue-fee mechanism

Production infrastructure

- Environment validation
- Authentication
- Rate limiting
- Restricted production CORS
- Structured logging and monitoring
- Database migrations
- Docker deployment
- CI/CD tests
- Provider failover
- Secrets management
- Security review
