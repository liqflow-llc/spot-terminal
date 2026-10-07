// Transaction failure modes: the things that go wrong between "prepare" and "landed" when a real
// person and a real wallet are in the loop. They're the hardest bugs to reproduce by hand, so each
// one is reproduced here on purpose:
//   - approving slowly (longer than a blockhash lives), and longer than our sign window
//   - abandoning a request, a wallet that changes the transaction, the wrong signer, double submits
//   - the chain changing between prepare and approval (order filled before the cancel is signed)
//   - not enough SOL, an exhausted sign-window pool
// Every failure must reach the user as a clear message (a UserError), never "Something went wrong".
//
// Self-contained: starts its own validator with 50 ms slots (8 ticks/slot) so a blockhash expires
// in ~8 s instead of ~60 s, and the sign window is 20 s instead of 5 minutes.
//
//   cd backend && node test/tx-e2e.mjs [path-to-chrome]
// Needs: network access (clones the Manifest program from mainnet), a test build of the frontend
// for the UI part: (cd frontend && npm run build:test).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.argv[2] || '/usr/bin/google-chrome';
const RPC_PORT = 8999;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const WINDOW_MS = 20_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-tx-'));
const dataDir = path.join(tmp, 'data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

// ---------- a fast local validator ----------
console.log('Starting a fast validator (50 ms slots)…');
const validator = spawn('solana-test-validator', [
    '--reset', '--ledger', path.join(tmp, 'ledger'), '--ticks-per-slot', '8',
    '--rpc-port', String(RPC_PORT), '--faucet-port', '9911', '--gossip-port', '9912', '--dynamic-port-range', '9920-9990',
    '--url', 'https://api.mainnet-beta.solana.com', '--clone-upgradeable-program', 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms',
], { stdio: 'ignore' });
let backend = null, browser = null;
const cleanup = () => {
    backend?.kill();
    validator.kill();
};
process.on('exit', cleanup);
for (let i = 0; ; i++) {
    try {
        const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' });
        if ((await r.json()).result === 'ok') break;
    } catch { /* starting */ }
    if (i > 120) throw new Error('validator did not start');
    await sleep(500);
}

process.env.RPC_URL = RPC;
process.env.WS_URL = `ws://127.0.0.1:${RPC_PORT + 1}`;
process.env.DATA_DIR = dataDir;
process.env.WATCH_POLL_MS = '1000';

const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction, ComputeBudgetProgram, sendAndConfirmTransaction } = await import('@solana/web3.js');
const spl = await import('@solana/spl-token');
const { Market, createSwapInstruction } = await import('@bonasa-tech/manifest-sdk');
const { connection } = await import('../src/solana.js');
// web3.js reuses a blockhash for up to 30 s; on this validator one lives ~8 s. Always fetch fresh.
connection._blockhashWithExpiryBlockHeight = () => connection.getLatestBlockhash('confirmed');
const { ManifestMarkets } = await import('../src/venues/manifest/markets.js');
const { vaultAddress } = await import('../src/venues/manifest/instructions.js');
const { OrderStore } = await import('../src/orders/orderStore.js');
const { OrderService, UserError } = await import('../src/orders/orderService.js');
const { Keeper, loadKeeperKeypair } = await import('../src/orders/keeper.js');
const { SignWindowPool } = await import('../src/orders/signWindow.js');

async function airdrop(pk, sol) {
    await connection.confirmTransaction(await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL), 'confirmed');
}
async function waitFor(fn, label, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(250);
    }
    throw new Error(`Timed out waiting for: ${label}`);
}

// ---------- chain setup ----------
console.log('Setting up wallets, tokens and a market…');
const maker = Keypair.generate(), taker = Keypair.generate(), poor = Keypair.generate();
const keeper = loadKeeperKeypair();
await Promise.all([airdrop(maker.publicKey, 50), airdrop(taker.publicKey, 50), airdrop(keeper.publicKey, 2)]);
await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: taker.publicKey, toPubkey: poor.publicKey, lamports: 2_000_000 })), [taker]);
const BASE = await spl.createMint(connection, taker, taker.publicKey, null, 6);
const QUOTE = await spl.createMint(connection, taker, taker.publicKey, null, 6);
for (const owner of [maker, taker]) {
    for (const mint of [BASE, QUOTE]) {
        const ata = await spl.getOrCreateAssociatedTokenAccount(connection, taker, mint, owner.publicKey);
        await spl.mintTo(connection, taker, mint, ata.address, taker, 1_000_000n * 10n ** 6n);
    }
}
const createMarket = async (base, quote) => {
    const { ixs, signers } = await Market.setupIxs(connection, base, quote, taker.publicKey);
    await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [taker, ...signers]);
    return signers[0].publicKey.toBase58();
};
const mBQ = await createMarket(BASE, QUOTE);

const markets = new ManifestMarkets();
await markets.scan();
const store = new OrderStore();
const pool = new SignWindowPool({ keypair: keeper, size: 6, windowMs: WINDOW_MS, file: path.join(dataDir, 'sign-window.json') });
await pool.start();
const service = new OrderService({ markets, store, keeperPubkey: keeper.publicKey, signWindow: pool });
const keeperSvc = new Keeper({ markets, store, keypair: keeper });
service.onPlaced = (id) => keeperSvc.track(id);
keeperSvc.start();
const wallet = maker.publicKey.toBase58();

// ---------- what a wallet does ----------
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const rawSign = (message, keypair) => crypto.sign(null, message, crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, Buffer.from(keypair.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' }));

function sign(prepared, signer = maker, { tamper = false } = {}) {
    const isVersioned = (i) => (prepared.versionFlags ? prepared.versionFlags[i] : prepared.versioned);
    return prepared.transactions.map((b64, i) => {
        if (isVersioned(i)) {
            const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
            tx.sign([signer]);
            return Buffer.from(tx.serialize()).toString('base64');
        }
        const tx = Transaction.from(Buffer.from(b64, 'base64'));
        if (tamper) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 })); // a "helpful" wallet
        if (signer === maker) {
            // Like a wallet: sign the message as it now stands, keep the other signatures as they are.
            tx.addSignature(maker.publicKey, rawSign(tx.serializeMessage(), maker));
        } else {
            // The wrong account's signature in the wallet's slot (another account in the same wallet).
            tx.addSignature(maker.publicKey, rawSign(tx.serializeMessage(), signer));
        }
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    });
}
const submit = (prepared, signed = sign(prepared)) => service.submit({ id: prepared.id, signed });

/** The failure must be a clear message for the user (not "Something went wrong"). */
async function expectUserError(promise, pattern) {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof UserError, `expected a clear message, got an internal error: ${err.message}`);
        assert.match(err.message, pattern);
        log('user sees:', JSON.stringify(err.message));
        return err;
    }
    throw new Error(`expected a failure matching ${pattern}`);
}

/** Wait until a blockhash fetched now is dead: a transaction built on it could no longer land. */
async function outliveABlockhash() {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const started = Date.now();
    await waitFor(async () => !(await connection.isBlockhashValid(blockhash, { commitment: 'confirmed' })).value, 'blockhash expiry', 60_000);
    log(`a blockhash from the prepare time is now dead (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

const usedWindow = (prepared) => !!service.pending.get(prepared.id)?.lives?.[0]?.lease;

async function placeOrder(params) {
    let prepared = await service.prepareOrder({ wallet, ...params });
    if (prepared.step === 'setup') {
        await submit(await service.prepareSetup({ wallet }));
        prepared = await service.prepareOrder({ wallet, ...params });
    }
    return store.get((await submit(prepared)).orderId);
}

async function takerBuys(market, quoteAtoms) {
    const m = await markets.refresh(market);
    const ix = createSwapInstruction({
        payer: taker.publicKey, market: new PublicKey(market),
        traderBase: spl.getAssociatedTokenAddressSync(m.baseMint(), taker.publicKey),
        traderQuote: spl.getAssociatedTokenAddressSync(m.quoteMint(), taker.publicKey),
        baseVault: vaultAddress(market, m.baseMint()), quoteVault: vaultAddress(market, m.quoteMint()),
        tokenProgramBase: spl.TOKEN_PROGRAM_ID,
    }, { params: { inAtoms: quoteAtoms.toString(), outAtoms: '0', isBaseIn: false, isExactIn: true } });
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [taker]);
}

const baseBalance = async (owner = maker.publicKey) => BigInt((await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(BASE, owner))).value.amount);

let failures = 0;
async function test(name, fn) {
    console.log(`\n▶ ${name}`);
    try {
        await fn();
        console.log('  ✔ passed');
    } catch (err) {
        failures++;
        console.log('  ✘ FAILED:', err.stack || err.message);
    }
}

// ---------- slow approval: longer than a blockhash lives, inside the window ----------

await test('Setup approved after a blockhash would have expired (the reported bug) still goes through', async () => {
    const prepared = await service.prepareSetup({ wallet });
    assert.ok(usedWindow(prepared), 'built on a sign-window nonce');
    await outliveABlockhash();
    await submit(prepared);
    assert.equal(store.noncesFor(wallet).length, 2, 'payout accounts created');
});

let open1;
await test('Order approved slowly still goes through', async () => {
    const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '3', size: '5' });
    assert.equal(prepared.step, 'sign');
    assert.ok(usedWindow(prepared));
    await outliveABlockhash();
    const res = await submit(prepared);
    open1 = store.get(res.orderId);
    assert.equal(open1.status, 'open');
});

await test('Edit approved slowly still goes through', async () => {
    const prepared = await service.prepareEdit({ wallet, orderId: open1.id, price: '3.5', size: '4' });
    assert.ok(usedWindow(prepared));
    await outliveABlockhash();
    const res = await submit(prepared);
    open1 = store.get(res.orderId);
    assert.equal(open1.status, 'open');
    assert.equal(open1.price, 3.5);
});

await test('Cancel approved slowly still goes through', async () => {
    const prepared = await service.prepareCancel({ wallet, orderId: open1.id });
    assert.ok(usedWindow(prepared));
    await outliveABlockhash();
    await submit(prepared);
    assert.equal(store.get(open1.id).status, 'cancelled');
});

await test('Cancel all approved slowly still goes through', async () => {
    const a = await placeOrder({ market: mBQ, side: 'sell', price: '40', size: '1' });
    const b = await placeOrder({ market: mBQ, side: 'sell', price: '41', size: '1' });
    const prepared = await service.prepareCancelAll({ wallet, market: mBQ });
    assert.ok(usedWindow(prepared));
    await outliveABlockhash();
    await submit(prepared);
    assert.equal(store.get(a.id).status, 'cancelled');
    assert.equal(store.get(b.id).status, 'cancelled');
});

await test('Create market approved slowly still goes through', async () => {
    const TOKEN = await spl.createMint(connection, taker, taker.publicKey, null, 6);
    const prepared = await service.prepareCreateMarket({ wallet, baseMint: TOKEN.toBase58(), quoteMint: QUOTE.toBase58() });
    assert.ok(usedWindow(prepared));
    await outliveABlockhash();
    const res = await submit(prepared);
    assert.ok(await connection.getAccountInfo(new PublicKey(res.market)), 'market exists');
});

// ---------- too slow: past the sign window ----------

await test('Approved after the sign window: refused clearly, nothing happens, and the signed copy can never land', async () => {
    const baseBefore = await baseBalance();
    const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '50', size: '1' });
    const signed = sign(prepared);
    const ordersBefore = store.forWallet(wallet).length;
    log(`waiting past the ${WINDOW_MS / 1000}s window…`);
    await sleep(WINDOW_MS + 1500);
    await expectUserError(submit(prepared, signed), /wasn't approved within/);
    assert.equal(store.forWallet(wallet).length, ordersBefore, 'no order recorded');
    // Someone who kept the signed transaction tries to send it anyway, after the void.
    await pool.sweep();
    await assert.rejects(connection.sendRawTransaction(Buffer.from(signed[0], 'base64')), 'the signed place transaction is dead');
    await sleep(1000);
    assert.equal(await baseBalance(), baseBefore, 'no tokens moved');
});

await test('An abandoned request\'s window nonce is voided before reuse', async () => {
    const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '50', size: '1' });
    const lease = service.pending.get(prepared.id).lives[0].lease;
    const signed = sign(prepared); // the user signed, then the page was closed before sending
    service.dropPending(prepared.id); // what the expiry timer does
    await pool.sweep();
    const n = pool.nonces.get(lease.address);
    assert.notEqual(n.value, lease.value, 'nonce advanced');
    assert.equal(n.state, 'free', 'and back in the pool');
    await assert.rejects(connection.sendRawTransaction(Buffer.from(signed[0], 'base64')), 'old signed copy is dead');
});

// ---------- wallets doing unexpected things ----------

await test('A wallet that changes the transaction is refused, and the request can still be approved properly', async () => {
    const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '60', size: '1' });
    await expectUserError(submit(prepared, sign(prepared, maker, { tamper: true })), /does not match/);
    const res = await submit(prepared);
    assert.equal(store.get(res.orderId).status, 'open');
    await submit(await service.prepareCancel({ wallet, orderId: res.orderId }));
});

await test('Signed by a different wallet: refused', async () => {
    const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '60', size: '1' });
    await expectUserError(submit(prepared, sign(prepared, taker)), /missing the wallet signature|Invalid signature/);
    service.dropPending(prepared.id);
});

await test('The same approval submitted twice (double click, retry): one order, a clear second answer', async () => {
    const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '70', size: '1' });
    const signed = sign(prepared);
    const before = store.forWallet(wallet).length;
    const [first, second] = await Promise.allSettled([submit(prepared, signed), submit(prepared, signed)]);
    assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1, 'exactly one went through');
    const rejected = [first, second].find(r => r.status === 'rejected').reason;
    assert.ok(rejected instanceof UserError, `clear message, got: ${rejected.message}`);
    log('user sees:', JSON.stringify(rejected.message));
    assert.equal(store.forWallet(wallet).length, before + 1);
    const placed = (first.status === 'fulfilled' ? first : second).value;
    await submit(await service.prepareCancel({ wallet, orderId: placed.orderId }));
});

// ---------- the chain changes between prepare and approval ----------

await test('Order fills before its cancel is approved: clear message, order stays filled and paid', async () => {
    const order = await placeOrder({ market: mBQ, side: 'sell', price: '2', size: '2' });
    const cancel = await service.prepareCancel({ wallet, orderId: order.id });
    await takerBuys(mBQ, 5_000_000n);
    await waitFor(() => store.get(order.id).status === 'claimed', 'keeper pays out');
    await expectUserError(submit(cancel), /can't go through anymore|changed/);
    assert.equal(store.get(order.id).status, 'claimed', 'not overwritten by the failed cancel');
});

await test('Order fills before its edit is approved: clear message, nothing changed', async () => {
    const order = await placeOrder({ market: mBQ, side: 'sell', price: '2', size: '2' });
    const edit = await service.prepareEdit({ wallet, orderId: order.id, price: '2.2', size: '2' });
    await takerBuys(mBQ, 5_000_000n);
    await waitFor(() => store.get(order.id).status === 'claimed', 'keeper pays out');
    await expectUserError(submit(edit), /claimed now|can't go through anymore/);
    assert.equal(store.get(order.id).status, 'claimed');
});

// ---------- money and capacity ----------

await test('Not enough SOL for the setup: a clear message', async () => {
    const prepared = await service.prepareSetup({ wallet: poor.publicKey.toBase58() });
    const signed = prepared.transactions.map(b64 => {
        const tx = Transaction.from(Buffer.from(b64, 'base64'));
        tx.addSignature(poor.publicKey, rawSign(tx.serializeMessage(), poor));
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    });
    await expectUserError(submit(prepared, signed), /Not enough SOL/);
});

await test('Sign-window pool exhausted: falls back to the ~1 minute window and still works', async () => {
    const held = [];
    for (let i = 0; ; i++) {
        const lease = pool.acquire(`filler-${i}`);
        if (!lease) break;
        held.push(lease);
    }
    log('held', held.length, 'leases; pool empty');
    try {
        const prepared = await service.prepareOrder({ wallet, market: mBQ, side: 'sell', price: '80', size: '1' });
        assert.ok(!usedWindow(prepared), 'recent blockhash instead');
        const res = await submit(prepared);
        assert.equal(store.get(res.orderId).status, 'open');
        await submit(await service.prepareCancel({ wallet, orderId: res.orderId }));
    } finally {
        held.forEach(l => pool.unuse(l));
    }
});

await test('An unsigned (rejected or abandoned) request never makes the next order ask for setup again', async () => {
    const w2 = Keypair.generate();
    await airdrop(w2.publicKey, 5);
    await spl.mintTo(connection, taker, BASE, await spl.createAssociatedTokenAccountIdempotent(connection, taker, BASE, w2.publicKey, { commitment: 'confirmed' }), taker, 100n * 10n ** 6n);
    const w = w2.publicKey.toBase58();
    const signAs = (prepared) => prepared.transactions.map(b64 => {
        const tx = Transaction.from(Buffer.from(b64, 'base64'));
        tx.addSignature(w2.publicKey, rawSign(tx.serializeMessage(), w2));
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    });
    const setup = await service.prepareSetup({ wallet: w });
    await service.submit({ id: setup.id, signed: signAs(setup) });
    const first = await service.prepareOrder({ wallet: w, market: mBQ, side: 'sell', price: '95', size: '1' });
    await service.submit({ id: first.id, signed: signAs(first) }); // one payout account now backs this order
    const rejected = await service.prepareOrder({ wallet: w, market: mBQ, side: 'sell', price: '96', size: '1' }); // holds the last one
    const again = await service.prepareOrder({ wallet: w, market: mBQ, side: 'sell', price: '96', size: '1' });
    assert.equal(again.step, 'sign', 'no second setup while the earlier request sits unsigned');
    await expectUserError(service.submit({ id: rejected.id, signed: signAs(rejected) }), /expired or was already sent/);
    service.abandon({ id: again.id });
    assert.ok(!service.pending.has(again.id), 'abandon frees it at once');
    const third = await service.prepareOrder({ wallet: w, market: mBQ, side: 'sell', price: '97', size: '1' });
    assert.equal(third.step, 'sign');
    const res = await service.submit({ id: third.id, signed: signAs(third) });
    assert.equal(store.get(res.orderId).status, 'open');
});

await test('The keeper only ever signs the nonce advance', async () => {
    const lease = pool.acquire('safety-check');
    const tx = new Transaction({ feePayer: maker.publicKey, blockhash: lease.value, lastValidBlockHeight: 0 });
    tx.add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: maker.publicKey, lamports: 1 }));
    assert.throws(() => pool.signLegacy(tx, lease), /refusing/);
    pool.unuse(lease);
});

await test('Refund approved slowly still goes through', async () => {
    const prepared = await service.prepareClosePayout({ wallet });
    assert.ok(usedWindow(prepared));
    await outliveABlockhash();
    const res = await submit(prepared);
    assert.ok(res.refundedSol > 0);
});

// ---------- the same, through the real UI ----------

await test('UI: slow at the setup dialog and slow in the wallet → order placed; too slow → clear message; reject → "Cancelled"', async () => {
    const dist = path.join(here, '../../frontend/dist-test');
    if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('build the test frontend first: (cd frontend && npm run build:test)');
    const { default: puppeteer } = await import('puppeteer-core');
    const { installMockWallet } = await import('./lib/mockWallet.mjs');
    const user = Keypair.generate();
    const uiKeeper = Keypair.generate();
    await Promise.all([airdrop(user.publicKey, 10), airdrop(uiKeeper.publicKey, 2)]);
    const ata = await spl.createAssociatedTokenAccountIdempotent(connection, taker, BASE, user.publicKey, { commitment: 'confirmed' });
    await spl.mintTo(connection, taker, BASE, ata, taker, 1_000n * 10n ** 6n);
    const uiData = path.join(tmp, 'ui-data');
    fs.mkdirSync(uiData, { recursive: true });
    fs.writeFileSync(path.join(uiData, 'keeper.json'), JSON.stringify([...uiKeeper.secretKey]));
    const PORT = 3023;
    backend = spawn(process.execPath, [path.join(here, '../src/server.js')], {
        env: {
            ...process.env, DATA_DIR: uiData, PORT: String(PORT), KEEPER_KEYPAIR: path.join(uiData, 'keeper.json'),
            FRONTEND_DIST: dist, SIGN_WINDOW_SECONDS: String(WINDOW_MS / 1000), SIGN_WINDOW_NONCES: '6',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let backendLog = '';
    backend.stdout.on('data', d => { backendLog += d; });
    backend.stderr.on('data', d => { backendLog += d; });
    await waitFor(() => backendLog.includes('[sign-window] ready'), 'backend sign window ready', 60_000);
    const base = `http://127.0.0.1:${PORT}`;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: path.join(tmp, 'chrome'), args: ['--no-first-run'] });
    let page;
    try {
        page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 920 });
        await installMockWallet(page, user);
        const clickText = async (selector, text) => {
            await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some(el => el.textContent.trim().includes(t)), { timeout: 30000 }, selector, text);
            await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find(el => el.textContent.trim().includes(t)).click(), selector, text);
        };
        const setField = async (label, value) => {
            const handle = await page.evaluateHandle((l) => [...document.querySelectorAll('.of-field')].find(f => f.textContent.includes(l)).querySelector('input'), label);
            await handle.click({ clickCount: 3 });
            await handle.type(value);
        };
        // Only toasts that appear after clearToasts() count. (Toasts are React's to remove; the test
        // just remembers which ones it has already seen.)
        const toastSays = (text, timeout) => page.waitForFunction((t) => [...document.querySelectorAll('.toast')]
            .some(el => !window.__oldToasts?.has(el) && el.textContent.includes(t)), { timeout }, text);
        const clearToasts = () => page.evaluate(() => { window.__oldToasts = new Set(document.querySelectorAll('.toast')); });

        await page.goto(`${base}/trade/${mBQ}`, { waitUntil: 'domcontentloaded' });
        await clickText('button', 'Select Wallet');
        await clickText('.wallet-adapter-modal button', 'Mock Wallet');
        await page.waitForFunction(() => !document.querySelector('.topbar .wallet-adapter-button')?.textContent.includes('Select'), { timeout: 15000 });

        log('UI: reading the setup dialog slowly, then approving slowly in the wallet');
        await clickText('.of-side', 'Sell');
        await setField('Price', '90');
        await setField('Amount', '1');
        await sleep(300);
        await clickText('.of-submit', 'Sell');
        await page.waitForFunction(() => document.querySelector('.modal')?.textContent.includes('Account page'), { timeout: 30000 });
        await sleep(10_000); // longer than a blockhash lives here
        await page.evaluate(() => { window.__wallet.delayMs = 10_000; });
        await clickText('.modal button', 'Continue');
        await toastSays('order placed', 90_000);
        assert.equal(await page.evaluate(() => window.__signCount), 2, 'setup + order');

        log('UI: approving after the window closes');
        await clearToasts();
        await page.evaluate((ms) => { window.__wallet.delayMs = ms; }, WINDOW_MS + 5000);
        await setField('Amount', '1');
        await clickText('.of-submit', 'Sell');
        await toastSays("wasn't approved within", WINDOW_MS + 60_000);
        const text = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
        log('UI shows:', text);
        assert.ok(!/Something went wrong/.test(text));

        log('UI: rejecting in the wallet');
        await clearToasts();
        await page.evaluate(() => { window.__wallet.delayMs = 0; window.__wallet.reject = true; });
        await setField('Amount', '1');
        await clickText('.of-submit', 'Sell');
        await toastSays('Cancelled in wallet', 30_000);
        await page.evaluate(() => { window.__wallet.reject = false; });

        log('UI: and right after, a normal order works');
        await clearToasts();
        await setField('Amount', '1');
        await clickText('.of-submit', 'Sell');
        await toastSays('order placed', 60_000);
    } catch (err) {
        // What the user was looking at, and what the server said.
        const toasts = await page?.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent)).catch(() => []);
        log('toasts on screen:', JSON.stringify(toasts));
        const form = await page?.evaluate(() => ({
            button: document.querySelector('.of-submit')?.textContent, disabled: document.querySelector('.of-submit')?.disabled,
            approvals: window.__signCount, modal: document.querySelector('.modal')?.textContent?.slice(0, 200),
            amount: [...document.querySelectorAll('.of-field')].find(f => f.textContent.includes('Amount'))?.querySelector('input')?.value,
        })).catch(() => null);
        log('order form:', JSON.stringify(form));
        await page?.screenshot({ path: path.join(os.tmpdir(), 'spot-tx-failure.png') }).catch(() => {});
        log('screenshot:', path.join(os.tmpdir(), 'spot-tx-failure.png'));
        log('backend log (last 40 lines):\n' + backendLog.split('\n').slice(-40).join('\n'));
        throw err;
    } finally {
        await browser.close();
        browser = null;
    }
    const internal = backendLog.split('\n').filter(l => /\[api\] failed|Something went wrong|\[client\] crash/.test(l));
    assert.equal(internal.length, 0, `requests failed with an internal error:\n${internal.join('\n')}`);
});

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll transaction tests passed');
keeperSvc.stop?.();
pool.stop();
cleanup();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
