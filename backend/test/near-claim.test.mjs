// Unit test for near-full payouts: the remainder allowance (under $5, capped at 10% of the
// order, 1% without a USD price), the payout amounts, and when the keeper sends which payout.
// The on-chain side (a payout withdrawing a fixed amount on a durable nonce) is the same as the
// full payout's, which test/localnet-e2e.mjs covers.
//   cd backend && node test/near-claim.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-near-'));
process.env.RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const { Keypair, PublicKey } = await import('@solana/web3.js');
const { OrderStore } = await import('../src/orders/orderStore.js');
const { OrderService } = await import('../src/orders/orderService.js');
const { Keeper } = await import('../src/orders/keeper.js');
const { orderEconomics, encodePrice } = await import('../src/venues/manifest/instructions.js');

const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------- the allowance ----------
const service = new OrderService({ markets: null, store: null, keeperPubkey: Keypair.generate().publicKey });
const dust = (base, price, usd) => {
    service.usdPrices = async () => (usd == null ? {} : { [QUOTE]: usd });
    return service.dustBaseAtoms({ baseAtoms: base * 1_000_000n, tokenPrice: price, quoteMint: QUOTE, baseDecimals: 6 });
};
assert.equal(await dust(1000n, 1, 1), 5_000_000n, '$5 of a $1 token is 5 tokens');
assert.equal(await dust(1000n, 0.5, 1), 10_000_000n, '$5 of a $0.50 token is 10 tokens');
assert.equal(await dust(1000n, 0.000685, 102), 71_561_471n, 'ANSEM at 0.000685 SOL, SOL $102: ~71.56 ANSEM');
assert.equal(await dust(20n, 1, 1), 2_000_000n, 'a $20 order: capped at 10%');
assert.equal(await dust(1000n, 1, null), 10_000_000n, 'no USD price: 1%');
service.usdPrices = async () => { throw new Error('price API down'); };
assert.equal(await service.dustBaseAtoms({ baseAtoms: 1000_000_000n, tokenPrice: 1, quoteMint: QUOTE, baseDecimals: 6 }), 10_000_000n, 'price lookup failing: 1%');

// ---------- payout amounts ----------
// A buy pays out base: everything but the allowance. A sell pays out quote for the base that sold.
const enc = encodePrice(2.5, 6, 6);
const fullSell = orderEconomics({ isBid: false, baseAtoms: 10_000_000n, mantissa: enc.mantissa, exponent: enc.exponent }).claimAtoms;
const nearSell = orderEconomics({ isBid: false, baseAtoms: 9_000_000n, mantissa: enc.mantissa, exponent: enc.exponent }).claimAtoms;
assert.equal(fullSell, 25_000_000n - 10n);
assert.equal(nearSell, 22_500_000n - 10n, 'sell 10, allowance 1: paid for 9');

// ---------- the keeper's choice ----------
const wallet = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey.toBase58();
let resting = [];      // [{ sequenceNumber, numBaseAtoms }]
let seatBase = 0n;
const market = {
    bids: () => resting.map(o => ({ sequenceNumber: BigInt(o.seq), numBaseAtoms: o.left })),
    asks: () => [],
    hasSeat: (pk) => pk.equals(wallet),
    getWithdrawableBalanceAtoms: (_pk, isBase) => (isBase ? seatBase : 0n),
};
const markets = { get: () => market, slot: 1000, on() {}, subscribe: () => () => {} };
const store = new OrderStore();
const keeper = new Keeper({ markets, store, keypair: Keypair.generate() });
const sent = [];
keeper.submitClaim = (order, opts = {}) => sent.push({ id: order.id, near: opts.remaining != null, remaining: opts.remaining });

const order = (id, extra = {}) => store.put({
    id, wallet: wallet.toBase58(), market: MARKET, status: 'open', isBid: true, proceedsIsBase: true, side: 'buy',
    baseAtoms: '100000000', claimAtoms: '100000000', mantissa: 1, exponent: 0, sequenceNumber: id.slice(-1), placeSlot: 1, nonce: `n-${id}`,
    claimTx: 'x', ...extra,
});
const check = () => { sent.length = 0; keeper.checkMarket(MARKET); return [...sent]; };
const NEAR = { nearClaimTx: 'y', dustBaseAtoms: '1000000', nearClaimAtoms: '99000000' };

order('order-1', NEAR);
resting = [{ seq: '1', left: 40_000_000n }]; seatBase = 60_000_000n;
assert.deepEqual(check(), [], '40% left: keep waiting');

resting = [{ seq: '1', left: 500_000n }]; seatBase = 99_500_000n;
assert.deepEqual(check(), [{ id: 'order-1', near: true, remaining: 500_000n }], '0.5 left (allowance 1): near-full payout');

resting = [{ seq: '1', left: 1_000_000n }]; seatBase = 98_000_000n;
assert.deepEqual(check(), [], 'exactly at the allowance, but the seat holds less than the near payout: wait');

resting = []; seatBase = 100_000_000n;
assert.deepEqual(check(), [{ id: 'order-1', near: false, remaining: undefined }], 'filled completely: the full payout');

store.update('order-1', { status: 'claimed' });
order('order-2'); // placed before near-full payouts existed
resting = [{ seq: '2', left: 42n }]; seatBase = 99_999_958n;
assert.deepEqual(check(), [], 'no near payout signed: wait (the app offers Collect)');

console.log('near-claim tests passed');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(0);
