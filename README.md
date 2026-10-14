# SpotTerminal

**[spotterminal.com](https://spotterminal.com)** · operated by LiqFlow LLC

A CEX-style trading frontend for Solana spot order books. Manifest is the primary venue; the
book view aggregates every Manifest market for a pair (including inverted listings) and shows
Archer's depth alongside it.

## Venues

Jupiter's router lists four on-chain order-book venues: Manifest, Archer, Phoenix and OpenBook V2.
Activity and book quality, measured on-chain from mainnet on October 4, 2026:

| Venue | Activity | Book quality | Retail limit orders | Verdict |
|---|---|---|---|---|
| **Manifest** | ~31k tx/h, 3,830 markets (896 two-sided) | SOL/USDC spread 0.03–0.36%; stables and LSTs at 0.002%; tokenized stocks (NVDAx, AMD…) | Yes, zero fees. Jupiter fills the whole book. | Primary venue |
| **Archer** | ~40k tx/h, 82 markets | Professional market-maker quotes | Yes, but a user's book only gets Jupiter flow if whitelisted in a registry (by Telegram DM). Per-market fees. API needs a key. | Depth shown in the book; liquidity taken through Jupiter; orders never placed there |
| Jupiter Limit V1 | ~78 tx/h | Mostly stale orders from 2024–25 | Via API, 0.1% fee on fill. Proceeds go straight to the wallet. | Not used (deprecated) |
| Phoenix (spot) | ~8 tx/h | Abandoned: JitoSOL/USDC 50 / 195, EURC 1.11 / 1.20 | Technically yes | Skip. Ellipsis pivoted Phoenix to perps (late 2025); imperial.space aggregates those perps. |
| OpenBook v1 / v2 | v1 ~1.7k tx/h (cranks), v2 ~26 tx/h | SOL/USDC 50 / 600 | Yes | Skip |

## Routing

- **Market orders** go through Jupiter's Swap API v2 (`/build`).
- **Limit orders** take Jupiter's better price first when Jupiter can beat the limit after the
  swap's network and priority fee. The rest rests on Manifest (no fees, and Jupiter routes
  through every order on the book), in the busiest Manifest market for the pair.
- **Archer** depth and trades are shown (trades marked with the A badge). Its liquidity is taken
  through Jupiter, which routes to it. Resting orders never go there: a user's Archer book only
  gets aggregator flow if Archer whitelists it, and fills stay in that book until withdrawn.
- **Pairs with no Manifest market** trade with market orders only, through Jupiter, or anyone can
  create a Manifest market for the pair (~0.007 SOL; SOL and USDC are the preset quotes). The
  market search finds existing empty markets first, so nobody creates a duplicate.

## Wallet abstraction

Users never deposit, withdraw or wrap SOL by hand. Manifest keeps fill proceeds in the trader's
balance inside the market, and only the owner's signature can withdraw them; durable nonces let
proceeds reach the wallet the moment an order fills, without a custom on-chain program.

- **Placing an order** is one wallet approval that signs two transactions:
  1. *place*: creates token accounts, wraps SOL if needed, claims a Manifest seat, deposits exactly
     what the order locks, places it, and unwraps leftover SOL;
  2. *claim*: a durable-nonce transaction that withdraws the order's full-fill proceeds to the
     user's own wallet (unwrapping SOL). The backend keeps it, and the keeper adds its fee-payer
     signature and submits it the moment the order has fully filled. The keeper can't change the
     transaction or send funds anywhere else: a claim can only ever pay its own user.
- **Cancelling** cancels, withdraws everything the wallet has in that market, and advances the
  nonce so the unused claim becomes invalid and the nonce is free for the next order.
- A wallet's **first order** needs a one-time setup approval that creates two nonce accounts
  (refundable rent, ~0.0029 SOL), because a claim must reference a nonce that already exists.
  Each order then reuses a free nonce, and a spare is topped up automatically.
  The **Account** page (`/account`) refunds that rent anytime: it closes every nonce account not
  backing an open order (`SystemProgram.nonceWithdraw` of the full balance); the next order asks
  for setup again.
- Partial fills stay in the market until the order fills completely, is cancelled, or the user
  withdraws from the app. The UI shows them, with a one-click withdraw.

Verified against the real Manifest program on a local validator (`test/localnet-e2e.mjs` plus a
UI test with a mock wallet):

- a full fill pays out (sell and buy), and SOL proceeds arrive as native SOL;
- a partial fill then cancel returns everything, and the stale claim is rejected;
- later orders take a single approval;
- an order that fills instantly still pays out;
- cancelling one order doesn't take another order's partial proceeds.

Bugs in Manifest's SDK this has to route around:

- The SDK's core deposit/withdraw builders add a byte the program rejects, so those two
  instructions are hand-encoded (`venues/manifest/instructions.js`).
- The program no longer emits `PlaceOrderLog`. Sequence numbers are read from the batch-update
  return data instead (`venues/manifest/fills.js`).

## Open risks

As of October 4, 2026:

- **Real-wallet behaviour.** Durable-nonce transactions signed via `signAllTransactions` passed
  with a mock wallet. Phantom, Solflare and Backpack each still need a small real order: do they
  warn, and do they keep the pre-signed nonce signature intact?
- **Keeper needs SOL** (~0.00001 per claim). If it runs dry, claims wait and users fall back to
  withdrawing manually.
- **Global orders.** Some Manifest liquidity is "global" (capital shared across markets) and may
  be unbacked at match time, so the book can overstate depth slightly.
- **Custody posture.** The server stores pre-signed claims. A leaked claim can only ever pay its
  own user, but treat the store as sensitive anyway.

## Layout

- `backend/` Node API (Express, ESM)
  - `venues/manifest/markets.js` incremental market scan (Helius getProgramAccountsV2), polled
    live books (one getMultipleAccounts per tick for all viewed markets), 24h volume from on-chain
    counters. No RPC websockets: Helius bills streaming at 20 credits/MB, and Manifest's log
    stream alone is ~0.9 GB/hour (it exhausted the plan on Oct 5, 2026).
  - `venues/manifest/inferFills.js` trades inferred from successive market snapshots
  - `venues/manifest/fills.js` FillLog / batch-update return-data parsing for our own transactions
  - `venues/manifest/instructions.js` core-program instructions and exact price/claim math
  - `venues/archer/archer.js` Archer market list (one filtered program-accounts call every few
    hours) and books from Archer's public WebSocket, subscribed only while a pair is viewed
  - `marketdata/` trades, 1m candles (GeckoTerminal backfill), aggregated books, all-DEX chart
  - `orders/` order service (prepare/verify/submit/cancel, Jupiter swaps), order store, keeper,
    ledger (what moved into / out of SpotTerminal and every fill, per wallet)
  - `tax/exports.js` CSV exports for Koinly, CoinTracker, CoinLedger, Awaken and CoinTracking
  - `test/localnet-e2e.mjs` end-to-end tests against the real Manifest program on a local validator
  - `test/tx-e2e.mjs` transaction failure modes (slow/rejected/changed approvals, stale state)
- `frontend/` React + Vite, TradingView Advanced Charts (licensed bundle, not committed)
- `deploy/` nginx configs
- `scripts/` charting-library setup and the production deploy

## Running

```bash
# .env in the repo root
HELIUS_API_KEY=...
# optional: JUP_API_KEY, PORT (3020), KEEPER_KEYPAIR (default data/keeper.json)

./scripts/setup-charting-library.sh          # copies the licensed TradingView bundle in
cd backend && npm install && npm start       # API on 127.0.0.1:3020
cd frontend && npm install && npm run dev    # UI on 127.0.0.1:5180 (proxies /api)
```

In production, `npm run build` in `frontend/` and the backend serves `frontend/dist` itself.

The keeper keypair is generated on first start; **fund it with a little SOL** before real use
(each claim costs ~0.00001 SOL in fees). Without SOL the keeper can't submit claims and filled
proceeds wait in the market until the user withdraws them from the app.

## Production

spotterminal.com runs as the `spot-terminal` pm2 app (`ecosystem.config.js`: one instance, so
two keepers never submit the same claims) on 127.0.0.1:3000, behind nginx
(`deploy/nginx-spotterminal.com`, HTTP redirects to HTTPS, Let's Encrypt cert). The keeper is
LiqFlow LLC's hot wallet, which only ever holds a little SOL.

```bash
./scripts/deploy.sh   # build the frontend and (re)start under pm2
```

## Tests

```bash
solana-test-validator --reset --ledger /tmp/ledger \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms
cd backend && node test/localnet-e2e.mjs   # order/claim/cancel mechanics
cd frontend && npm run build:test && cd ../backend && node test/ui-e2e.mjs
                                            # the real UI in Chrome with a mock wallet (builds to dist-test, never dist)
```

Transaction failure modes have their own suite, which starts its own validator with 50 ms slots
(a blockhash dies in ~8 s instead of ~60-90 s) so slow approvals reproduce in seconds:

```bash
cd frontend && npm run build:test && cd ../backend && node test/tx-e2e.mjs
```

The tax CSV formats (each app's exact template headers, dates, currencies) have a quick unit test,
and localnet-e2e reconciles the tax ledger against what SpotTerminal holds on chain:

```bash
cd backend && node test/tax-exports.test.mjs
```

The UI and transaction suites fail on any request that ends in "Something went wrong" (an internal error).
