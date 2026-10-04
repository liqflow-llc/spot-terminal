# Spot Aggregator (working name)

A CEX-style trading frontend for Solana spot order books. Manifest is the primary venue; the
book view aggregates every Manifest market for a pair (including inverted listings), with more
venues to come.

## Wallet abstraction

Users never deposit, withdraw or wrap SOL by hand.

- **Placing an order** is one wallet approval that signs two transactions:
  1. *place*: creates token accounts, wraps SOL if needed, claims a Manifest seat, deposits exactly
     what the order locks, places it, and unwraps leftover SOL;
  2. *claim*: a durable-nonce transaction that withdraws the order's full-fill proceeds to the
     user's own wallet (unwrapping SOL). The backend keeps it and the keeper submits it the moment
     the order has fully filled, paying the fee itself. It can only ever pay the user.
- **Cancelling** cancels, withdraws everything the wallet has in that market, and advances the
  nonce so the unused claim becomes invalid.
- A wallet's **first order** needs a one-time setup approval that creates two nonce accounts
  (refundable rent, ~0.0029 SOL), because a claim must reference a nonce that already exists.
  Each order then reuses a free nonce, and a spare is topped up automatically.
- Partial fills stay in the market until the order fills completely, is cancelled, or the user
  withdraws from the app.

## Layout

- `backend/` Node API (Express, ESM)
  - `venues/manifest/markets.js` market scan, live websocket books, 24h volume from on-chain counters
  - `venues/manifest/fills.js` live fills from a logs subscription; batch-update return data
  - `venues/manifest/instructions.js` core-program instructions and exact price/claim math
  - `marketdata/` trades, 1m candles (GeckoTerminal backfill), aggregated books
  - `orders/` order service (prepare/verify/submit/cancel), order store, keeper
  - `test/localnet-e2e.mjs` end-to-end tests against the real Manifest program on a local validator
- `frontend/` React + Vite, TradingView Advanced Charts (licensed bundle, not committed)

## Running

```bash
# .env in the repo root
HELIUS_API_KEY=...
# optional: JUP_API_KEY, PORT (3020), KEEPER_KEYPAIR (default data/keeper.json)

cd backend && npm install && npm start
```

The keeper keypair is generated on first start; fund it with a little SOL (each claim costs
~0.00001 SOL in fees).

## Tests

```bash
solana-test-validator --reset --ledger /tmp/ledger \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms
cd backend && node test/localnet-e2e.mjs
```
