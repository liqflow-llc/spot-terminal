// UI end-to-end test: drives the real built frontend in Chrome with a mock Wallet Standard
// wallet (signing with a funded localnet keypair), against a backend pointed at a local
// validator running the real Manifest program. Places a sell order through the UI, fills it
// from a taker, and checks the UI reports it as paid out.
//
// Prereqs: local validator as in localnet-e2e.mjs; a test build of the frontend:
//   (cd frontend && npx vite build --outDir dist-test)   (never the production dist/)
// Run from backend/: node test/ui-e2e.mjs [path-to-chrome]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import { Market, createSwapInstruction } from '@bonasa-tech/manifest-sdk';
import { installMockWallet } from './lib/mockWallet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.argv[2] || '/usr/bin/google-chrome';
const PORT = 3021;
const RPC = 'http://127.0.0.1:8899';
const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-ui-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-ui-data-'));
const connection = new Connection(RPC, 'confirmed');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const step = (msg) => console.log(`▶ ${msg}`);

async function airdrop(pk, sol) {
    await connection.confirmTransaction(await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL), 'confirmed');
}

// ---------- chain setup ----------
step('Creating tokens, market and funded wallets on localnet');
const user = Keypair.generate();
const taker = Keypair.generate();
await Promise.all([airdrop(user.publicKey, 20), airdrop(taker.publicKey, 20)]);
const BASE = await spl.createMint(connection, taker, taker.publicKey, null, 6);
const QUOTE = await spl.createMint(connection, taker, taker.publicKey, null, 6);
for (const owner of [user, taker]) {
    for (const mint of [BASE, QUOTE]) {
        const ata = await spl.getOrCreateAssociatedTokenAccount(connection, taker, mint, owner.publicKey);
        await spl.mintTo(connection, taker, mint, ata.address, taker, 1_000_000n * 10n ** 6n);
    }
}
const { ixs, signers } = await Market.setupIxs(connection, BASE, QUOTE, taker.publicKey);
await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [taker, ...signers]);
const market = signers[0].publicKey.toBase58();
const NEW_TOKEN = await spl.createMint(connection, taker, taker.publicKey, null, 9); // has no market yet
const NEW_TOKEN2 = await spl.createMint(connection, taker, taker.publicKey, null, 6); // for an arbitrary-quote market
await spl.mintTo(connection, taker, NEW_TOKEN, (await spl.getOrCreateAssociatedTokenAccount(connection, taker, NEW_TOKEN, user.publicKey)).address, taker, 1_000n * 10n ** 9n);
console.log('  market', market, 'user', user.publicKey.toBase58());

// ---------- backend on localnet ----------
step('Starting backend against localnet');
const keeperPath = path.join(dataDir, 'keeper.json');
const keeper = Keypair.generate();
fs.writeFileSync(keeperPath, JSON.stringify([...keeper.secretKey]));
await airdrop(keeper.publicKey, 2);
const backend = spawn(process.execPath, [path.join(here, '../src/server.js')], {
    // Serves the test build (frontend/dist-test), never the production one.
    env: { ...process.env, RPC_URL: RPC, WS_URL: 'ws://127.0.0.1:8900', DATA_DIR: dataDir, PORT: String(PORT), KEEPER_KEYPAIR: keeperPath, FRONTEND_DIST: path.join(here, '../../frontend/dist-test') },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', d => { backendLog += d; });
backend.stderr.on('data', d => { backendLog += d; });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
    try {
        if ((await fetch(`${base}/api/markets/${market}`)).ok) break;
    } catch { /* not up yet */ }
    await sleep(500);
}

let failed = false;
const errors = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: path.join(dataDir, 'chrome'), args: ['--no-first-run'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 920 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text()}`));

    await installMockWallet(page, user); // signs in Node; see lib/mockWallet.mjs
    await page.evaluateOnNewDocument(() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = (url, opts) => (window.__refStub != null && String(url).endsWith('/reference')
            ? Promise.resolve(new Response(JSON.stringify({ price: window.__refStub, source: 'Jupiter', at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }))
            : realFetch(url, opts));
    });

    const clickText = async (selector, text) => {
        await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some(el => el.textContent.trim().includes(t)), { timeout: 20000 }, selector, text);
        await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find(el => el.textContent.trim().includes(t)).click(), selector, text);
    };
    // Addresses are pasted, like people do. (Typing 44 characters with simulated key presses in
    // headless Chrome sometimes loses keystrokes without the page losing focus: a harness quirk.)
    const paste = (selector, text) => page.$eval(selector, (el, t) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, t);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    const shot = async (name) => {
        const file = path.join(shotsDir, `${name}.png`);
        await page.screenshot({ path: file });
        console.log('  screenshot', file);
    };

    step('Opening the market and connecting the wallet');
    await page.goto(`${base}/trade/${market}`, { waitUntil: 'domcontentloaded' });
    await clickText('button', 'Select Wallet');
    await clickText('.wallet-adapter-modal button', 'Mock Wallet');
    await page.waitForFunction(() => document.querySelector('.topbar .wallet-adapter-button')?.textContent.includes('…') ||
        !document.querySelector('.topbar .wallet-adapter-button')?.textContent.includes('Select'), { timeout: 15000 });

    step('Placing a sell order: 10 @ 2.5');
    await clickText('.of-side', 'Sell');
    const setField = async (label, value) => {
        const handle = await page.evaluateHandle((l) => [...document.querySelectorAll('.of-field')].find(f => f.textContent.includes(l)).querySelector('input'), label);
        await handle.click({ clickCount: 3 });
        await handle.type(value);
    };
    await setField('Price', '2.5');
    await setField('Amount', '10');
    await sleep(300);
    await clickText('.of-submit', 'Sell');
    // First order: the one-time setup dialog.
    await page.waitForFunction(() => document.querySelector('.modal')?.textContent.includes('Account page'), { timeout: 20000 });
    await shot('0-setup-dialog');
    await clickText('.modal button', 'Continue');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('order placed')), { timeout: 60000 });
    const approvals = await page.evaluate(() => window.__signCount);
    console.log(`  wallet approvals so far: ${approvals} (setup + order)`);
    if (approvals !== 2) throw new Error(`expected 2 approvals (setup, then order+claim together), got ${approvals}`);
    await page.waitForFunction(() => document.querySelector('.ap-table tbody tr')?.textContent.includes('Open'), { timeout: 20000 });
    step('The order appears in the live order book');
    await page.waitForFunction(() => [...document.querySelectorAll('.ob-row.ask')].some(r => r.textContent.includes('2.50')), { timeout: 15000 });
    await shot('1-order-open');

    step('A taker fills the whole order');
    const [baseVault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(market).toBuffer(), BASE.toBuffer()], new PublicKey('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms'));
    const [quoteVault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(market).toBuffer(), QUOTE.toBuffer()], new PublicKey('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms'));
    const swapIx = createSwapInstruction({
        payer: taker.publicKey, market: new PublicKey(market),
        traderBase: spl.getAssociatedTokenAddressSync(BASE, taker.publicKey),
        traderQuote: spl.getAssociatedTokenAddressSync(QUOTE, taker.publicKey),
        baseVault, quoteVault, tokenProgramBase: spl.TOKEN_PROGRAM_ID,
    }, { params: { inAtoms: '30000000', outAtoms: '0', isBaseIn: false, isExactIn: true } });
    const quoteBefore = BigInt((await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(QUOTE, user.publicKey))).value.amount);
    await sendAndConfirmTransaction(connection, new Transaction().add(swapIx), [taker]);

    step('Waiting for the automatic payout to show in the UI');
    await clickText('.tab', 'Order history');
    await page.waitForFunction(() => document.querySelector('.ap-table')?.textContent.includes('paid to wallet'), { timeout: 60000 });
    const quoteAfter = BigInt((await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(QUOTE, user.publicKey))).value.amount);
    console.log(`  wallet received ${(Number(quoteAfter - quoteBefore) / 1e6).toFixed(6)} QUOTE with no further approval`);
    if (quoteAfter - quoteBefore < 24_999_000n) throw new Error('payout did not reach the wallet');
    if (await page.evaluate(() => window.__signCount) !== 2) throw new Error('payout should not need another approval');
    await shot('2-paid-out');

    step('Closing the account with an order still open: confirm, one approval, order cancelled, rent refunded');
    await setField('Price', '9');
    await setField('Amount', '1');
    await clickText('.of-submit', 'Sell');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].filter(t => t.textContent.includes('order placed')).length >= 1 && window.__signCount === 3, { timeout: 60000 });
    const baseBeforeClose = BigInt((await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(BASE, user.publicKey))).value.amount);
    await clickText('.topnav-item', 'Account');
    await page.waitForFunction(() => document.querySelector('.account-warning')?.textContent.includes('cancels your 1 open order'), { timeout: 20000 });
    await clickText('.account-card button', 'Close account and refund');
    await page.waitForFunction(() => document.querySelector('.modal.danger')?.textContent.includes('Close account?'), { timeout: 10000 });
    await clickText('.modal button', 'Cancel orders and close');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('Account closed')), { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.account-card')].some(c => c.textContent.includes('Nothing to close')), { timeout: 20000 });
    if (await page.evaluate(() => window.__signCount) !== 4) throw new Error('closing the account should be exactly one approval');
    const baseAfterClose = BigInt((await connection.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(BASE, user.publicKey))).value.amount);
    if (baseAfterClose - baseBeforeClose !== 1_000_000n) throw new Error(`the cancelled order's 1 BASE should be back (got ${baseAfterClose - baseBeforeClose})`);

    step('Tax reports: the Account page offers a CSV per tax app, and the Koinly one holds this history');
    await page.waitForFunction(() => document.querySelectorAll('.tax-apps a').length === 5, { timeout: 20000 });
    const koinlyHref = await page.$eval('.tax-apps a', a => a.getAttribute('href'));
    const koinly = await (await fetch(`${base}${koinlyHref}`)).text();
    const lines = koinly.trim().split('\r\n');
    console.log('  koinly csv:\n   ' + lines.join('\n   '));
    if (lines[0] !== 'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Tag,Description,TxHash') throw new Error('Koinly header');
    for (const want of ['payout-account rent deposit', 'funds for a limit order', 'limit order sell 10', 'filled order paid out', 'cancelled orders, funds returned', 'account closed, rent refunded']) {
        if (!koinly.includes(want)) throw new Error(`Koinly CSV is missing: ${want}`);
    }
    if (!lines.slice(1).filter(l => !l.includes('limit order sell')).every(l => /,[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(l))) throw new Error('every deposit / withdrawal carries its transaction hash');
    await shot('3-refunded');

    step('A buy priced far above the market gets a strong warning, and can be backed out of');
    const stub = await page.evaluateOnNewDocument(() => { window.__refStub = 1; });
    await page.goto(`${base}/trade/${market}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.selector-btn .pair-name', { timeout: 20000 });
    await clickText('.of-side', 'Buy');
    await setField('Price', '2');
    await setField('Amount', '1');
    await page.waitForFunction(() => document.querySelector('.of-note.danger')?.textContent.includes('above the market price'), { timeout: 40000 });
    await clickText('.of-submit', 'Buy');
    await page.waitForFunction(() => document.querySelector('.modal.danger')?.textContent.includes('100.0% above'), { timeout: 10000 });
    await shot('4a-price-warning');
    const before = await page.evaluate(() => window.__signCount);
    await clickText('.modal button', 'Change price');
    await sleep(800);
    if (await page.$('.modal')) throw new Error('warning dialog did not close');
    if (await page.evaluate(() => window.__signCount) !== before) throw new Error('backing out must not ask the wallet');
    await page.removeScriptToEvaluateOnNewDocument(stub.identifier);
    await page.evaluate(() => { window.__refStub = null; });

    step('Market tab quotes through Jupiter (localnet tokens have no route, so it says so)');
    await clickText('.of-type-tab', 'Market');
    await page.type('.order-form .of-field input', '5');
    await page.waitForFunction(() => document.querySelector('.order-form .of-note.warn')?.textContent.includes('No route'), { timeout: 30000 });
    await clickText('.of-type-tab', 'Limit');

    step('Starring a market puts it at the top of the list');
    await page.click('.market-header > .star');
    await page.click('.selector-btn');
    await page.waitForSelector('.selector-row', { timeout: 20000 });
    await page.waitForFunction((m) => document.querySelector('.selector-row')?.classList.contains('fav'), { timeout: 10000 }, market);
    const starredStored = await page.evaluate(() => JSON.parse(localStorage.getItem('spot.favoriteMarkets') || '[]'));
    if (starredStored[0] !== market) throw new Error(`favorite not stored: ${starredStored}`);
    await shot('4b-favorite');
    await page.keyboard.press('Escape');

    step('Sorting the market list by a column');
    await page.goto(`${base}/trade/${market}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.selector-btn .pair-name', { timeout: 20000 });
    await page.click('.selector-btn');
    await page.waitForSelector('.selector-row', { timeout: 20000 });
    await clickText('.selector-sort', 'Pair');
    await page.waitForFunction(() => document.querySelector('.selector-sort.active')?.textContent.includes('▲'), { timeout: 5000 });
    await clickText('.selector-sort', 'Pair');
    await page.waitForFunction(() => document.querySelector('.selector-sort.active')?.textContent.includes('▼'), { timeout: 5000 });
    await shot('4-sorted');

    step('Creating a market for a token that has none');
    await page.keyboard.press('Escape');
    await page.click('.selector-btn');
    await page.waitForSelector('.selector-search');
    await paste('.selector-search', NEW_TOKEN.toBase58());
    await clickText('.selector-create button', '/SOL');
    await page.waitForFunction(() => document.querySelector('.modal')?.textContent.includes('SOL (network rent'), { timeout: 30000 });
    await shot('5-create-market');
    await clickText('.modal button', 'Create market');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('market created')), { timeout: 60000 });
    await page.waitForFunction((m) => location.pathname.startsWith('/trade/') && !location.pathname.endsWith(m), { timeout: 20000 }, market);
    const created = page.url().split('/trade/')[1];
    const info = await (await fetch(`${base}/api/markets/${created}`)).json();
    if (info.base?.mint !== NEW_TOKEN.toBase58() || info.quote?.symbol !== 'SOL') throw new Error(`unexpected market ${JSON.stringify(info).slice(0, 200)}`);
    console.log(`  created ${info.symbol} market ${created}`);
    await page.waitForFunction(() => document.querySelector('.selector-btn .pair-name')?.textContent.endsWith('/SOL'), { timeout: 20000 });
    // The chart switches to the new market (its legend shows the new symbol).
    const chartFrame = () => page.frames().find(f => f.url().startsWith('blob:'));
    const end = Date.now() + 30000;
    let legend = '';
    while (Date.now() < end) {
        legend = await chartFrame()?.evaluate(() => document.body.innerText).catch(() => '') || '';
        if (legend.includes('/ SOL')) break;
        await sleep(500);
    }
    if (!legend.includes('/ SOL')) throw new Error(`chart did not switch to the new market (chart shows: ${legend.split('\n').filter(l => /Manifest|\//.test(l)).slice(0, 6).join(' | ')}; frames: ${page.frames().map(f => f.url().slice(0, 30))})`);
    const priceBox = await page.evaluate(() => [...document.querySelectorAll('.of-field')].find(f => f.textContent.includes('Price')).querySelector('input').value);
    if (priceBox !== '') throw new Error(`price box kept the previous market's price (${priceBox})`);
    await shot('6-new-market');

    step('Creating a market against any quote token, from the button at the end of the list');
    await page.click('.selector-btn');
    await page.waitForSelector('.selector-create-any', { timeout: 20000 });
    await page.click('.selector-create-any');
    await page.waitForSelector('#cm-base');
    await paste('#cm-base', NEW_TOKEN2.toBase58());
    await page.waitForSelector('.cm-token', { timeout: 20000 }); // base token looked up
    await clickText('.cm-chip', 'Other token');
    await page.waitForSelector('.cm-form input:not(#cm-base)');
    await paste('.cm-form input:not(#cm-base)', QUOTE.toBase58());
    await page.waitForFunction(() => document.querySelectorAll('.cm-token').length === 2, { timeout: 20000 });
    await clickText('.modal button', 'Continue');
    await page.waitForFunction(() => document.querySelector('.modal')?.textContent.includes('network rent'), { timeout: 30000 });
    await clickText('.modal button', 'Create market');
    await page.waitForFunction((m) => !location.pathname.endsWith(m), { timeout: 60000 }, created); // toasts may have expired
    const created2 = page.url().split('/trade/')[1];
    const info2 = await (await fetch(`${base}/api/markets/${created2}`)).json();
    if (info2.base?.mint !== NEW_TOKEN2.toBase58() || info2.quote?.mint !== QUOTE.toBase58()) throw new Error(`unexpected market ${JSON.stringify(info2).slice(0, 200)}`);
    console.log(`  created ${info2.symbol} (arbitrary quote)`);
    await shot('6b-arbitrary-quote');

    step('Quote filter returns only that quote token\'s pairs');
    const solOnly = await (await fetch(`${base}/api/markets?quote=So11111111111111111111111111111111111111112&q=${NEW_TOKEN.toBase58()}`)).json();
    if (!solOnly.markets.length || solOnly.markets.some(m => m.quote.symbol !== 'SOL')) throw new Error(`SOL filter wrong: ${JSON.stringify(solOnly).slice(0, 200)}`);

    step('Open orders: place with an expiry, edit the price, then cancel all');
    await page.goto(`${base}/trade/${market}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.selector-btn .pair-name', { timeout: 20000 });
    const placeSell = async (price, amount, expiry) => {
        await clickText('.of-side', 'Sell');
        await setField('Price', price);
        await setField('Amount', amount);
        if (expiry) await page.select('.of-expiry select', expiry);
        await sleep(300);
        await clickText('.of-submit', 'Sell');
        // After the refund earlier, the next order asks for the deposit again.
        const setup = await page.waitForFunction(() => document.querySelector('.modal')?.textContent.includes('deposit') || [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('order placed')), { timeout: 60000 });
        if (await page.evaluate(() => !!document.querySelector('.modal'))) await clickText('.modal button', 'Continue');
        await page.waitForFunction((p) => [...document.querySelectorAll('.ap-table tbody tr')].some(r => r.textContent.includes(p) && r.textContent.includes('Open')), { timeout: 60000 }, price);
    };
    await clickText('.tab', 'Open orders');
    await placeSell('9', '1', '86400');
    const expiresCell = await page.evaluate(() => [...document.querySelectorAll('.ap-table tbody tr')].find(r => r.textContent.includes('9.0'))?.textContent || '');
    if (!/23h|1d/.test(expiresCell)) throw new Error(`expiry not shown: ${expiresCell}`);
    await page.evaluate(() => [...document.querySelectorAll('.ap-table tbody tr')].find(r => r.textContent.includes('9.0')).querySelector('button').click());
    await page.waitForSelector('.edit-order');
    const priceInput = await page.$('.edit-order input');
    await priceInput.click({ clickCount: 3 });
    await priceInput.type('9.5');
    await clickText('.modal button', 'Save');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('Order updated')), { timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.ap-table tbody tr')].some(r => r.textContent.includes('9.5') && r.textContent.includes('Open')), { timeout: 30000 });
    await placeSell('11', '1');
    await shot('6c-open-orders');
    await clickText('.panel-title button', 'Cancel all');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('Orders cancelled')), { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.ap-body')?.textContent.includes('No open orders'), { timeout: 30000 });

    step('Terms and Privacy pages render');
    for (const [path, heading] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((h) => document.querySelector('.legal-main h1')?.textContent === h, { timeout: 10000 }, heading);
    }
    await shot('7-privacy');
    if (errors.length) console.log('  page errors:', errors.slice(0, 5));
    // Any request that failed with an internal error (the user sees "Something went wrong"), or a
    // page crash, fails the run even if the flow above carried on.
    const internal = backendLog.split('\n').filter(l => /\[api\] failed|Something went wrong|\[client\] crash/.test(l));
    if (internal.length) throw new Error(`internal errors during the run:\n${internal.join('\n')}`);
    console.log('\nUI test passed');
} catch (err) {
    failed = true;
    console.log('\nUI test FAILED:', err.message);
    if (errors.length) console.log('  page errors:', errors.slice(-5));
    console.log(backendLog.split('\n').filter(l => /error|fail|Keeper/i.test(l)).slice(-15).join('\n'));
    try { await (await browser.pages())[1]?.screenshot({ path: path.join(shotsDir, 'failure.png') }); console.log('  failure screenshot', path.join(shotsDir, 'failure.png')); } catch { /* ignore */ }
} finally {
    const clientErrors = backendLog.split('\n').filter(l => l.includes('[client]'));
    if (clientErrors.length) console.log('  errors reported by the page:\n   ' + clientErrors.slice(-8).join('\n   '));
    await browser.close();
    backend.kill();
}
process.exit(failed ? 1 : 0);
