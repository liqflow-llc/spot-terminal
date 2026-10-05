// UI end-to-end test: drives the real built frontend in Chrome with a mock Wallet Standard
// wallet (signing with a funded localnet keypair), against a backend pointed at a local
// validator running the real Manifest program. Places a sell order through the UI, fills it
// from a taker, and checks the UI reports it as paid out.
//
// Prereqs: local validator as in localnet-e2e.mjs; `npm run build` in frontend/.
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
await spl.mintTo(connection, taker, NEW_TOKEN, (await spl.getOrCreateAssociatedTokenAccount(connection, taker, NEW_TOKEN, user.publicKey)).address, taker, 1_000n * 10n ** 9n);
console.log('  market', market, 'user', user.publicKey.toBase58());

// ---------- backend on localnet ----------
step('Starting backend against localnet');
const keeperPath = path.join(dataDir, 'keeper.json');
const keeper = Keypair.generate();
fs.writeFileSync(keeperPath, JSON.stringify([...keeper.secretKey]));
await airdrop(keeper.publicKey, 2);
const backend = spawn(process.execPath, [path.join(here, '../src/server.js')], {
    env: { ...process.env, RPC_URL: RPC, WS_URL: 'ws://127.0.0.1:8900', DATA_DIR: dataDir, PORT: String(PORT), KEEPER_KEYPAIR: keeperPath },
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: path.join(dataDir, 'chrome'), args: ['--no-first-run'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 920 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // The page asks Node to sign: the mock wallet holds no key itself.
    await page.exposeFunction('__mockSign', (b64) => {
        const tx = Transaction.from(Buffer.from(b64, 'base64'));
        tx.partialSign(user);
        return tx.serialize({ requireAllSignatures: false }).toString('base64');
    });
    await page.evaluateOnNewDocument(() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = (url, opts) => (window.__refStub != null && String(url).endsWith('/reference')
            ? Promise.resolve(new Response(JSON.stringify({ price: window.__refStub, source: 'Jupiter', at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }))
            : realFetch(url, opts));
    });
    await page.evaluateOnNewDocument((address, pubkeyBytes) => {
        const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
        const listeners = { change: new Set() };
        const account = {
            address,
            publicKey: new Uint8Array(pubkeyBytes),
            chains: ['solana:mainnet', 'solana:localnet'],
            features: ['solana:signTransaction', 'solana:signAndSendTransaction'],
        };
        const wallet = {
            version: '1.0.0',
            name: 'Mock Wallet',
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==',
            chains: ['solana:mainnet', 'solana:localnet'],
            accounts: [],
            features: {
                'standard:connect': {
                    version: '1.0.0',
                    connect: async () => {
                        wallet.accounts = [account];
                        listeners.change.forEach(fn => fn({ accounts: wallet.accounts }));
                        return { accounts: wallet.accounts };
                    },
                },
                'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
                'standard:events': {
                    version: '1.0.0',
                    on: (event, fn) => { listeners[event]?.add(fn); return () => listeners[event]?.delete(fn); },
                },
                'solana:signTransaction': {
                    version: '1.0.0',
                    supportedTransactionVersions: ['legacy', 0],
                    signTransaction: async (...inputs) => {
                        window.__signCount = (window.__signCount || 0) + 1; // one call = one approval
                        const out = [];
                        for (const input of inputs) {
                            out.push({ signedTransaction: b64ToBytes(await window.__mockSign(bytesToB64(input.transaction))) });
                        }
                        return out;
                    },
                },
                'solana:signAndSendTransaction': {
                    version: '1.0.0',
                    supportedTransactionVersions: ['legacy', 0],
                    signAndSendTransaction: async () => { throw new Error('not used'); },
                },
            },
        };
        const register = ({ register: reg }) => reg(wallet);
        window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
        window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    }, user.publicKey.toBase58(), [...user.publicKey.toBytes()]);

    const clickText = async (selector, text) => {
        await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some(el => el.textContent.trim().includes(t)), { timeout: 20000 }, selector, text);
        await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find(el => el.textContent.trim().includes(t)).click(), selector, text);
    };
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

    step('Refunding the setup deposit from the Account page');
    await clickText('.topnav-item', 'Account');
    await clickText('.account-card button', 'Refund');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-title')].some(t => t.textContent.includes('Refunded')), { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.account-card')?.textContent.includes('Nothing to refund'), { timeout: 20000 });
    if (await page.evaluate(() => window.__signCount) !== 3) throw new Error('refund should be exactly one approval');
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
    await page.type('.selector-search', NEW_TOKEN.toBase58());
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

    step('Terms and Privacy pages render');
    for (const [path, heading] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((h) => document.querySelector('.legal-main h1')?.textContent === h, { timeout: 10000 }, heading);
    }
    await shot('7-privacy');
    if (errors.length) console.log('  page errors:', errors.slice(0, 5));
    console.log('\nUI test passed');
} catch (err) {
    failed = true;
    console.log('\nUI test FAILED:', err.message);
    console.log(backendLog.split('\n').filter(l => /error|fail|Keeper/i.test(l)).slice(-15).join('\n'));
    try { await (await browser.pages())[1]?.screenshot({ path: path.join(shotsDir, 'failure.png') }); console.log('  failure screenshot', path.join(shotsDir, 'failure.png')); } catch { /* ignore */ }
} finally {
    await browser.close();
    backend.kill();
}
process.exit(failed ? 1 : 0);
