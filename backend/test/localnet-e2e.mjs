// End-to-end test of order placement, automatic claims and cancels against the REAL Manifest
// program on a local validator (no real funds). Start the validator first:
//
//   solana-test-validator --reset --ledger /tmp/ledger \
//     --url https://api.mainnet-beta.solana.com \
//     --clone-upgradeable-program MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms
//
// then, from backend/: node test/localnet-e2e.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-e2e-'));
process.env.RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
process.env.WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8900';
process.env.DATA_DIR = dataDir;
process.env.WATCH_POLL_MS = process.env.WATCH_POLL_MS || '2000'; // keeper polling; production uses 15s

const { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
const spl = await import('@solana/spl-token');
const { Market, createSwapInstruction } = await import('@bonasa-tech/manifest-sdk');
const { connection } = await import('../src/solana.js');
const { ManifestMarkets } = await import('../src/venues/manifest/markets.js');
const { vaultAddress } = await import('../src/venues/manifest/instructions.js');
const { OrderStore } = await import('../src/orders/orderStore.js');
const { OrderService } = await import('../src/orders/orderService.js');
const { Keeper, loadKeeperKeypair } = await import('../src/orders/keeper.js');

const NATIVE = spl.NATIVE_MINT;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

async function airdrop(pk, sol) {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
}

async function tokenBalance(owner, mint) {
    if (mint.equals(NATIVE)) return BigInt(await connection.getBalance(owner, 'confirmed'));
    try {
        return BigInt((await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(mint, owner), 'confirmed')).value.amount);
    } catch {
        return 0n;
    }
}

async function waitFor(fn, label, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(500);
    }
    throw new Error(`Timed out waiting for: ${label}`);
}

// ---------- setup ----------
console.log('Setting up accounts, mints and markets…');
const maker = Keypair.generate();   // the app user
const taker = Keypair.generate();   // someone (e.g. Jupiter) trading against the user's orders
const keeper = loadKeeperKeypair();
await Promise.all([airdrop(maker.publicKey, 100), airdrop(taker.publicKey, 100), airdrop(keeper.publicKey, 2)]);

const BASE = await spl.createMint(connection, taker, taker.publicKey, null, 6);
const QUOTE = await spl.createMint(connection, taker, taker.publicKey, null, 6);
for (const owner of [maker, taker]) {
    for (const mint of [BASE, QUOTE]) {
        const ata = await spl.getOrCreateAssociatedTokenAccount(connection, taker, mint, owner.publicKey);
        await spl.mintTo(connection, taker, mint, ata.address, taker, 1_000_000n * 10n ** 6n);
    }
}
// Taker also needs a wSOL account to receive SOL from swaps.
await spl.getOrCreateAssociatedTokenAccount(connection, taker, NATIVE, taker.publicKey);

async function createMarket(base, quote) {
    const { ixs, signers } = await Market.setupIxs(connection, base, quote, taker.publicKey);
    await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [taker, ...signers]);
    return signers[0].publicKey.toBase58();
}
const mBQ = await createMarket(BASE, QUOTE);
const mBS = await createMarket(BASE, NATIVE);
log('markets', mBQ, '(BASE/QUOTE)', mBS, '(BASE/SOL)');

const markets = new ManifestMarkets();
await markets.scan();
const store = new OrderStore();
const service = new OrderService({ markets, store, keeperPubkey: keeper.publicKey });
const keeperSvc = new Keeper({ markets, store, keypair: keeper });
service.onPlaced = (id) => keeperSvc.track(id);
keeperSvc.start();
const inferred = []; // trades the market poller inferred from snapshots
markets.on('fills', (address, fills) => fills.forEach(f => inferred.push({ address, ...f })));

/** What a wallet does: sign every transaction it is handed, then send them back. */
async function signAndSubmit(prepared, signer = maker) {
    const signed = prepared.transactions.map(b64 => {
        const tx = Transaction.from(Buffer.from(b64, 'base64'));
        tx.partialSign(signer);
        return tx.serialize({ requireAllSignatures: false }).toString('base64');
    });
    return service.submit({ id: prepared.id, signed });
}

async function placeOrder(params) {
    let prepared = await service.prepareOrder({ wallet: maker.publicKey.toBase58(), ...params });
    if (prepared.step === 'setup') {
        log('first order: one-time payout setup (creates nonce accounts)');
        await signAndSubmit(prepared);
        prepared = await service.prepareOrder({ wallet: maker.publicKey.toBase58(), ...params });
    }
    assert.equal(prepared.step, 'sign');
    assert.equal(prepared.transactions.length, 2, 'order + claim signed together');
    const res = await signAndSubmit(prepared);
    return store.get(res.orderId);
}

async function swap(market, { baseIn, inAtoms }) {
    const m = await markets.refresh(market);
    const base = m.baseMint(), quote = m.quoteMint();
    const ix = createSwapInstruction({
        payer: taker.publicKey,
        market: new PublicKey(market),
        traderBase: spl.getAssociatedTokenAddressSync(base, taker.publicKey),
        traderQuote: spl.getAssociatedTokenAddressSync(quote, taker.publicKey),
        baseVault: vaultAddress(market, base),
        quoteVault: vaultAddress(market, quote),
        tokenProgramBase: spl.TOKEN_PROGRAM_ID,
    }, { params: { inAtoms: inAtoms.toString(), outAtoms: '0', isBaseIn: baseIn, isExactIn: true } });
    const pre = quote.equals(NATIVE) && !baseIn ? [
        // Fund taker's wSOL for SOL-in swaps.
        (await import('@solana/web3.js')).SystemProgram.transfer({ fromPubkey: taker.publicKey, toPubkey: spl.getAssociatedTokenAddressSync(NATIVE, taker.publicKey), lamports: inAtoms }),
        spl.createSyncNativeInstruction(spl.getAssociatedTokenAddressSync(NATIVE, taker.publicKey)),
    ] : [];
    await sendAndConfirmTransaction(connection, new Transaction().add(...pre, ix), [taker]);
}

const seatBalance = async (market, isBase) => {
    const m = await markets.refresh(market);
    return m.hasSeat(maker.publicKey) ? BigInt(m.getWithdrawableBalanceAtoms(maker.publicKey, isBase).toString()) : 0n;
};

let failures = 0;
async function test(name, fn) {
    console.log(`\n▶ ${name}`);
    try {
        await fn();
        console.log('  ✔ passed');
    } catch (err) {
        failures++;
        console.log('  ✘ FAILED:', err.message);
    }
}

// ---------- tests ----------

await test('Sell order fully filled → proceeds land in wallet automatically', async () => {
    const quoteBefore = await tokenBalance(maker.publicKey, QUOTE);
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    const order = await placeOrder({ market: mBQ, side: 'sell', price: '2.5', size: '10' });
    log('order', order.status, 'seq', order.sequenceNumber, 'claim', order.claimAtoms, 'quote atoms');
    assert.equal(order.status, 'open');
    assert.equal(baseBefore - await tokenBalance(maker.publicKey, BASE), 10_000_000n, 'exactly 10 BASE left the wallet');

    await swap(mBQ, { baseIn: false, inAtoms: 30_000_000n }); // taker buys with 30 QUOTE, more than enough
    const claimed = await waitFor(() => store.get(order.id).status === 'claimed' && store.get(order.id), 'keeper claim');
    const gained = await tokenBalance(maker.publicKey, QUOTE) - quoteBefore;
    log('claim tx', claimed.claimSignature.slice(0, 16) + '…', 'wallet +', gained, 'quote atoms');
    assert.equal(gained, 25_000_000n - 10n, '25 QUOTE (minus 10-atom rounding slack) returned to wallet');
    const seen = inferred.filter(f => f.address === mBQ);
    log('inferred trades:', JSON.stringify(seen));
    assert.ok(seen.some(f => f.side === 'buy' && Math.abs(f.price - 2.5) < 1e-9 && Math.abs(f.size - 10) < 1e-9), 'the fill was inferred from snapshots (buy 10 @ 2.5)');
    log('dust left in market:', await seatBalance(mBQ, false), 'quote atoms');
});

await test('Buy order paid in SOL, fully filled → base tokens land in wallet', async () => {
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    const order = await placeOrder({ market: mBS, side: 'buy', price: '0.5', size: '4' });
    assert.equal(order.status, 'open');
    log('locked', order.lockAtoms, 'lamports (2 SOL)');
    await swap(mBS, { baseIn: true, inAtoms: 5_000_000n }); // taker sells 5 BASE
    await waitFor(() => store.get(order.id).status === 'claimed', 'keeper claim');
    const gained = await tokenBalance(maker.publicKey, BASE) - baseBefore;
    log('wallet +', gained, 'base atoms');
    assert.equal(gained, 4_000_000n, 'exactly 4 BASE returned to wallet');
});

await test('Sell for SOL, fully filled → native SOL lands in wallet (wSOL unwrapped)', async () => {
    const order = await placeOrder({ market: mBS, side: 'sell', price: '0.4', size: '2' });
    const solBefore = await tokenBalance(maker.publicKey, NATIVE);
    await swap(mBS, { baseIn: false, inAtoms: 1_000_000_000n }); // taker buys with 1 SOL
    const claimed = await waitFor(() => store.get(order.id).status === 'claimed' && store.get(order.id), 'keeper claim');
    const gained = await tokenBalance(maker.publicKey, NATIVE) - solBefore;
    log('wallet +', gained, 'lamports native SOL; claim', claimed.claimSignature.slice(0, 16) + '…');
    // The keeper paid the fee, so the wallet gains the full 0.8 SOL minus the 10-atom slack.
    assert.equal(gained, 800_000_000n - 10n, '0.8 SOL returned as native SOL');
    const wsol = await connection.getAccountInfo(spl.getAssociatedTokenAddressSync(NATIVE, maker.publicKey));
    assert.equal(wsol, null, 'no wSOL account left behind');
});

await test('Partially filled then cancelled → everything back in wallet, stale claim is void', async () => {
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    const quoteBefore = await tokenBalance(maker.publicKey, QUOTE);
    const order = await placeOrder({ market: mBQ, side: 'sell', price: '3', size: '10' });
    await swap(mBQ, { baseIn: false, inAtoms: 12_000_000n }); // buys 4 BASE
    await sleep(3000);
    assert.equal(store.get(order.id).status, 'open', 'partial fill does not trigger the claim');

    const cancel = await service.prepareCancel({ wallet: maker.publicKey.toBase58(), orderId: order.id });
    await signAndSubmit(cancel);
    assert.equal(store.get(order.id).status, 'cancelled');
    const baseNet = await tokenBalance(maker.publicKey, BASE) - baseBefore;
    const quoteNet = await tokenBalance(maker.publicKey, QUOTE) - quoteBefore;
    log('net wallet change: base', baseNet, 'quote', quoteNet);
    assert.equal(baseNet, -4_000_000n, 'only the 4 BASE that sold are gone');
    // 12 QUOTE from the partial fill, plus any rounding dust earlier tests left in this market
    // (cancel sweeps everything the wallet has there).
    assert.ok(quoteNet >= 12_000_000n && quoteNet <= 12_000_100n, `12 QUOTE received (got ${quoteNet})`);
    assert.equal(await seatBalance(mBQ, true), 0n);
    assert.equal(await seatBalance(mBQ, false), 0n);

    // The unused pre-signed claim must no longer be valid (nonce advanced by the cancel).
    const stale = Transaction.from(Buffer.from(order.claimTx, 'base64'));
    stale.partialSign(keeper);
    await assert.rejects(connection.sendRawTransaction(stale.serialize()), 'stale claim rejected');
    log('stale claim rejected as expected');
});

await test('Later orders are a single approval (nonce accounts are reused)', async () => {
    const prepared = await service.prepareOrder({ wallet: maker.publicKey.toBase58(), market: mBQ, side: 'buy', price: '1', size: '1' });
    assert.equal(prepared.step, 'sign', 'no setup step');
    log('free nonce accounts:', store.noncesFor(maker.publicKey.toBase58()).length);
});

await test('Order that crosses the spread executes immediately and still pays out', async () => {
    // An ask rests at 2.0; the user's buy at 2.2 takes it in full on arrival.
    const restingAsk = await service.prepareOrder({ wallet: maker.publicKey.toBase58(), market: mBQ, side: 'sell', price: '2', size: '3' });
    await signAndSubmit(restingAsk); // maker's own ask as liquidity (self-trade is allowed on Manifest)
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    const order = await placeOrder({ market: mBQ, side: 'buy', price: '2.2', size: '3' });
    await waitFor(() => store.get(order.id).status === 'claimed', 'claim of immediately-filled order');
    log('immediately filled buy claimed; base delta', await tokenBalance(maker.publicKey, BASE) - baseBefore);
});

await test('Cancelling one order keeps another order\'s partial proceeds for its claim', async () => {
    const quoteBefore = await tokenBalance(maker.publicKey, QUOTE);
    const a = await placeOrder({ market: mBQ, side: 'sell', price: '5', size: '4' });   // claim ≈ 20 QUOTE
    const b = await placeOrder({ market: mBQ, side: 'sell', price: '9', size: '1' });
    await swap(mBQ, { baseIn: false, inAtoms: 10_000_000n }); // fills 2 of A's 4 BASE at 5
    await sleep(2000);
    const cancel = await service.prepareCancel({ wallet: maker.publicKey.toBase58(), orderId: b.id });
    await signAndSubmit(cancel);
    log('after cancelling B, A\'s partial proceeds still in market:', await seatBalance(mBQ, false), 'quote atoms');
    await sleep(2500); // give the keeper a chance to (wrongly) treat A's proceeds as B's fill
    assert.equal(store.get(b.id).status, 'cancelled', 'B stays cancelled; A\'s proceeds are not mistaken for B\'s');
    await swap(mBQ, { baseIn: false, inAtoms: 10_000_000n }); // fills the rest of A
    await waitFor(() => store.get(a.id).status === 'claimed', 'claim for A after B was cancelled');
    const gained = await tokenBalance(maker.publicKey, QUOTE) - quoteBefore;
    log('wallet +', gained, 'quote atoms in total');
    assert.ok(gained >= 20_000_000n - 20n, 'A paid out its full 20 QUOTE');
});

await test('Setup deposit is refundable; accounts backing open orders are kept', async () => {
    const wallet = maker.publicKey.toBase58();
    service.pending.clear(); // earlier tests left unsigned prepares holding nonces (they expire on their own)
    const open = await placeOrder({ market: mBQ, side: 'sell', price: '50', size: '1' }); // rests, never fills here
    const before = await service.payoutAccounts(wallet);
    log('payout accounts', before.accounts.length, 'in use', before.inUseCount, 'refundable', before.refundableSol, 'SOL');
    assert.ok(before.inUseCount >= 1, 'the open order\'s account is in use');
    assert.ok(before.refundableSol > 0, 'something to refund');
    assert.ok(before.accounts.find(a => a.address === open.nonce)?.inUse, 'open order nonce marked in use');

    const solBefore = await tokenBalance(maker.publicKey, NATIVE);
    const res = await signAndSubmit(await service.prepareClosePayout({ wallet }));
    const gained = await tokenBalance(maker.publicKey, NATIVE) - solBefore;
    log('refunded', res.refundedSol, 'SOL; wallet +', gained, 'lamports (after fee)');
    assert.equal(res.refundedSol, before.refundableSol);
    assert.ok(gained > BigInt(Math.round(before.refundableSol * 1e9)) - 100_000n, 'deposit back in wallet, minus a tx fee');
    assert.ok(await connection.getAccountInfo(new PublicKey(open.nonce)), 'open order\'s payout account still exists');
    const after = await service.payoutAccounts(wallet);
    assert.equal(after.refundableSol, 0, 'nothing left to refund while the order is open');
    await assert.rejects(service.prepareClosePayout({ wallet }), /backing open orders/);

    // The open order still pays out to the wallet if it fills.
    const quoteBefore = await tokenBalance(maker.publicKey, QUOTE);
    await swap(mBQ, { baseIn: false, inAtoms: 60_000_000n });
    await waitFor(() => store.get(open.id).status === 'claimed', 'claim after refund of the other accounts');
    assert.ok(await tokenBalance(maker.publicKey, QUOTE) - quoteBefore >= 50_000_000n - 10n, 'open order paid out');

    // Its account is free now: refund it too, and the next order asks for setup again.
    await signAndSubmit(await service.prepareClosePayout({ wallet }));
    const left = await service.payoutAccounts(wallet);
    assert.equal(left.accounts.length, 0, `all payout accounts closed (left: ${JSON.stringify(left.accounts)}; orders: ${JSON.stringify(store.forWallet(wallet).map(o => [o.status, o.nonce.slice(0, 6)]))})`);
    const next = await service.prepareOrder({ wallet, market: mBQ, side: 'buy', price: '1', size: '1' });
    assert.equal(next.step, 'setup', 'setup required again after the refund');
});

await test('Anyone can create a market for a token that has none, then trade it', async () => {
    const wallet = maker.publicKey.toBase58();
    const TOKEN = await spl.createMint(connection, taker, taker.publicKey, null, 9);
    await spl.mintTo(connection, taker, TOKEN, (await spl.getOrCreateAssociatedTokenAccount(connection, taker, TOKEN, maker.publicKey)).address, taker, 1_000n * 10n ** 9n);
    const prepared = await service.prepareCreateMarket({ wallet, baseMint: TOKEN.toBase58(), quoteMint: NATIVE.toBase58() });
    assert.equal(prepared.step, 'sign');
    log('create cost', prepared.summary.costSol, 'SOL');
    assert.ok(prepared.summary.costSol > 0 && prepared.summary.costSol < 0.05, 'cost is small rent');
    const res = await signAndSubmit(prepared);
    assert.equal(res.market, prepared.market);
    const again = await service.prepareCreateMarket({ wallet, baseMint: TOKEN.toBase58(), quoteMint: NATIVE.toBase58() });
    assert.deepEqual(again, { step: 'exists', market: res.market }, 'no duplicate market');
    const order = await placeOrder({ market: res.market, side: 'sell', price: '0.01', size: '100' });
    assert.equal(order.status, 'open', 'first order rests on the new market');
    await assert.rejects(service.prepareCreateMarket({ wallet, baseMint: maker.publicKey.toBase58(), quoteMint: NATIVE.toBase58() }), /not a token mint/);
});

await test('Orders priced >5% through the market need explicit consent', async () => {
    const guarded = new OrderService({ markets, store, keeperPubkey: keeper.publicKey, referencePrice: async () => 1 });
    const wallet = maker.publicKey.toBase58();
    await assert.rejects(guarded.prepareOrder({ wallet, market: mBQ, side: 'buy', price: '1.06', size: '1' }), e => e.code === 'PRICE_DEVIATION');
    await assert.rejects(guarded.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '0.94', size: '1' }), e => e.code === 'PRICE_DEVIATION');
    // Within 5%, or on the safe side, or acknowledged: allowed.
    for (const params of [{ side: 'buy', price: '1.04' }, { side: 'buy', price: '0.5' }, { side: 'sell', price: '3' }, { side: 'buy', price: '1.5', acknowledgePriceRisk: true }]) {
        const prepared = await guarded.prepareOrder({ wallet, market: mBQ, size: '1', ...params });
        assert.ok(['sign', 'setup'].includes(prepared.step), JSON.stringify(params));
    }
});

await test('Edit a partly filled order: new price and size, old proceeds and surplus returned, new one pays out', async () => {
    const wallet = maker.publicKey.toBase58();
    const order = await placeOrder({ market: mBQ, side: 'sell', price: '3', size: '10' });
    await swap(mBQ, { baseIn: false, inAtoms: 6_000_000n }); // buys 2 BASE at 3
    await sleep(2500);
    const baseBefore = await tokenBalance(maker.publicKey, BASE), quoteBefore = await tokenBalance(maker.publicKey, QUOTE);
    const prepared = await service.prepareEdit({ wallet, orderId: order.id, price: '4', size: '5' });
    const res = await signAndSubmit(prepared);
    const fresh = store.get(res.orderId), old = store.get(order.id);
    log('old', old.status, 'replacedBy', old.replacedBy?.slice(0, 8), '| new', fresh.status, fresh.price, fresh.baseAtoms);
    assert.equal(old.status, 'cancelled');
    assert.equal(old.replacedBy, fresh.id);
    assert.equal(fresh.status, 'open');
    const baseBack = await tokenBalance(maker.publicKey, BASE) - baseBefore;
    const quoteBack = await tokenBalance(maker.publicKey, QUOTE) - quoteBefore;
    log('returned: base', baseBack, 'quote', quoteBack);
    assert.equal(baseBack, 3_000_000n, '8 BASE were left; 5 stay on the book, 3 come back');
    assert.ok(quoteBack >= 6_000_000n - 10n && quoteBack <= 6_000_100n, `the 2 BASE sold at 3 paid out (got ${quoteBack})`);
    // The old payout is void (its nonce was advanced).
    const stale = Transaction.from(Buffer.from(order.claimTx, 'base64'));
    stale.partialSign(keeper);
    await assert.rejects(connection.sendRawTransaction(stale.serialize()));
    // The new order pays out on fill.
    const q2 = await tokenBalance(maker.publicKey, QUOTE);
    await swap(mBQ, { baseIn: false, inAtoms: 25_000_000n });
    await waitFor(() => store.get(fresh.id).status === 'claimed', 'claim of edited order');
    assert.ok(await tokenBalance(maker.publicKey, QUOTE) - q2 >= 20_000_000n - 10n, 'edited order paid 5 x 4');
});

await test('Cancel all cancels every order on the market and returns the funds', async () => {
    const wallet = maker.publicKey.toBase58();
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    const a = await placeOrder({ market: mBQ, side: 'sell', price: '40', size: '1' });
    const b = await placeOrder({ market: mBQ, side: 'sell', price: '41', size: '2' });
    const res = await signAndSubmit(await service.prepareCancelAll({ wallet, market: mBQ }));
    log('cancelled', res.cancelled);
    assert.ok(res.cancelled >= 2);
    assert.equal(store.get(a.id).status, 'cancelled');
    assert.equal(store.get(b.id).status, 'cancelled');
    assert.equal(await tokenBalance(maker.publicKey, BASE), baseBefore, 'all 3 BASE back in the wallet');
    await assert.rejects(service.prepareCancelAll({ wallet, market: mBQ }), /No open orders/);
});

await test('Close account: cancels open orders on every market, returns their funds, refunds all rent', async () => {
    const wallet = maker.publicKey.toBase58();
    const a = await placeOrder({ market: mBQ, side: 'sell', price: '70', size: '1' });
    const b = await placeOrder({ market: mBS, side: 'sell', price: '70', size: '2' });
    const before = await service.payoutAccounts(wallet);
    log('open orders', before.openOrders, 'payout accounts', before.accounts.length, 'rent', before.totalSol, 'SOL');
    assert.ok(before.openOrders >= 2);
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    const solBefore = await tokenBalance(maker.publicKey, NATIVE);
    const prepared = await service.prepareCloseAccount({ wallet });
    log('one approval signs', prepared.transactions.length, 'transactions');
    const res = await signAndSubmit(prepared);
    log('cancelled', res.cancelled, 'refunded', res.refundedSol, 'SOL');
    assert.equal(res.cancelled, before.openOrders);
    assert.equal(store.get(a.id).status, 'cancelled');
    assert.equal(store.get(b.id).status, 'cancelled');
    assert.equal(store.forWallet(wallet).filter(o => o.status === 'open' || o.status === 'expired').length, 0, 'no open orders left');
    assert.ok(await tokenBalance(maker.publicKey, BASE) - baseBefore >= 3_000_000n, 'the orders\' BASE is back');
    assert.ok(await tokenBalance(maker.publicKey, NATIVE) - solBefore > BigInt(Math.round(before.totalSol * 1e9)) - 200_000n, 'rent back, minus fees');
    assert.equal((await service.payoutAccounts(wallet)).accounts.length, 0, 'all payout accounts closed');
    assert.equal((await service.prepareOrder({ wallet, market: mBQ, side: 'buy', price: '1', size: '1' })).step, 'setup', 'next order sets up again');
    await assert.rejects(service.prepareCloseAccount({ wallet }), /nothing to close/);
});

await test('An expired order is marked expired and its funds come back with one withdraw', async () => {
    const wallet = maker.publicKey.toBase58();
    const baseBefore = await tokenBalance(maker.publicKey, BASE);
    let prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '60', size: '1', expiresInSeconds: 60 });
    if (prepared.step === 'setup') { await signAndSubmit(prepared); prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '60', size: '1', expiresInSeconds: 60 }); }
    const order = store.get((await signAndSubmit(prepared)).orderId);
    assert.ok(order.lastValidSlot > 0 && order.expiresAt > Date.now());
    log('waiting for slot', order.lastValidSlot, '…');
    await waitFor(() => store.get(order.id).status === 'expired', 'keeper marks it expired', 120_000);
    assert.equal(await tokenBalance(maker.publicKey, BASE), baseBefore - 1_000_000n, 'funds still locked until withdrawn');
    await signAndSubmit(await service.prepareCancel({ wallet, orderId: order.id }));
    assert.equal(store.get(order.id).status, 'cancelled');
    assert.equal(await tokenBalance(maker.publicKey, BASE), baseBefore, 'the 1 BASE is back');
});

await sleep(1000);
console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
