// A wallet's trading history, read from its own transactions on-chain: Manifest orders (placed
// through SpotTerminal, manifest.trade's wrapper program or anything else: their placements,
// cancels, deposits, withdrawals and fills on arrival) and Jupiter swaps, plus the payout (nonce)
// accounts it set up. The chain is the record; data/history/<wallet>.json only caches what has been
// parsed (a transaction never changes), so each transaction is fetched once.
//
// What the wallet's own transactions can't show: fills against a resting order happen in the
// taker's transaction. An order that left the book without being cancelled (and didn't expire) was
// filled completely, and a resting order's fill is its size minus what's left, but how much of a
// cancelled order filled first isn't recorded anywhere the wallet signed: that stays unknown.
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey } from '@solana/web3.js';
import { AGGREGATOR_PROGRAM_IDS, BatchUpdateStruct, CancelOrderLog, DepositLog, FillLog, PlaceOrderLog, WithdrawLog } from '@bonasa-tech/manifest-sdk';
import { quoteForBase } from '../venues/manifest/instructions.js';
import { connection } from '../solana.js';
import { rpc } from '../rpcRaw.js';
import { config } from '../config.js';
import { manifestDataLogs, parseFills } from '../venues/manifest/fills.js';
import { errorDetail, log, short } from '../log.js';

const MANIFEST = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const BATCH_UPDATE = 6;
// Anchor events emitted by self-CPI: an 8-byte tag, then the event's own 8-byte discriminator.
const EVENT_TAG = 'e445a52e51cb9a1d';
const JUP_SWAPS_EVENT = '982f4eebc0606e6a'; // Vec<{ input_mint, input_amount, output_mint, output_amount, amm }>
const JUP_SWAP_EVENT = '40c6cde8260871e2';  // { amm, input_mint, input_amount, output_mint, output_amount }
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 365;
const FETCH_BATCH = 4;        // transactions per RPC call
const FETCH_GAP_MS = 1000;    // between calls, shared by all scans: ~4/s leaves the RPC plan room for the app
const VERSION = 2; // bump when parseTransaction records more: caches are re-read
// A cancelled order's fills are in its takers' transactions: read the market's transactions
// between its placement and its cancel, when there are at most this many (quiet markets).
const FILL_SCAN_MAX = 150;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pk = (b) => new PublicKey(b).toBase58();

// ---------- parsing one transaction ----------

// Manifest event discriminators: keccak of the program id + "manifest::logs::<Name>" (as fills.js).
const EVENT_TYPES = { FillLog, DepositLog, WithdrawLog, CancelOrderLog, PlaceOrderLog };
const EVENT_BY_DISCRIMINATOR = Object.fromEntries(Object.keys(EVENT_TYPES).map(name => [
    Buffer.from(keccak_256(Buffer.concat([Buffer.from(bs58.decode(MANIFEST)), Buffer.from(`manifest::logs::${name}`)]))).subarray(0, 8).toString('hex'),
    name,
]));

/** Manifest events this transaction logged, in order: { name, data } with `data` decoded. */
function manifestEvents(logs) {
    const out = [];
    for (const b64 of manifestDataLogs(logs)) {
        const buf = Buffer.from(b64, 'base64');
        const name = EVENT_BY_DISCRIMINATOR[buf.subarray(0, 8).toString('hex')];
        if (!name) continue;
        try {
            out.push({ name, data: EVENT_TYPES[name].deserialize(buf.subarray(8))[0] });
        } catch {
            // A layout we don't know (another program version): skip it.
        }
    }
    return out;
}

/** Each Manifest batch update's return data, in execution order: the sequence numbers it placed. */
function batchReturns(logs) {
    const prefix = `Program return: ${MANIFEST} `;
    return (logs || []).filter(l => l.startsWith(prefix)).map((l) => {
        const buf = Buffer.from(l.slice(prefix.length), 'base64');
        if (buf.length < 4) return [];
        const count = buf.readUInt32LE(0);
        const seqs = [];
        for (let i = 0; i < count && 4 + i * 12 + 8 <= buf.length; i++) seqs.push(buf.readBigUInt64LE(4 + i * 12).toString());
        return seqs;
    });
}

/** Top-level instructions, each followed by its inner ones: the order they executed in. */
function executionOrder(tx) {
    const inner = new Map((tx.meta?.innerInstructions || []).map(g => [g.index, g.instructions]));
    return tx.transaction.message.instructions.flatMap((ix, i) => [ix, ...(inner.get(i) || [])]);
}
const programOf = (ix) => (ix.programId?.toBase58 ? ix.programId.toBase58() : String(ix.programId));
const accountsOf = (ix) => (ix.accounts || []).map(a => (a.toBase58 ? a.toBase58() : String(a)));

/** Net token amounts a Jupiter swap took in and paid out, from its swap events; null if none. */
function jupiterSwap(ixs) {
    const net = new Map(); // mint -> bigint (out positive)
    const venues = new Set();
    const add = (mint, v) => net.set(mint, (net.get(mint) || 0n) + v);
    for (const ix of ixs) {
        if (programOf(ix) !== JUPITER || !ix.data) continue;
        const d = Buffer.from(bs58.decode(ix.data));
        if (d.length < 16 || d.subarray(0, 8).toString('hex') !== EVENT_TAG) continue;
        const disc = d.subarray(8, 16).toString('hex');
        if (disc === JUP_SWAPS_EVENT && d.length >= 20) {
            const n = d.readUInt32LE(16);
            for (let i = 0; i < n && 20 + (i + 1) * 112 <= d.length; i++) {
                const o = 20 + i * 112;
                add(pk(d.subarray(o, o + 32)), -d.readBigUInt64LE(o + 32));
                add(pk(d.subarray(o + 40, o + 72)), d.readBigUInt64LE(o + 72));
                venues.add(pk(d.subarray(o + 80, o + 112)));
            }
        } else if (disc === JUP_SWAP_EVENT && d.length >= 128) {
            venues.add(pk(d.subarray(16, 48)));
            add(pk(d.subarray(48, 80)), -d.readBigUInt64LE(80));
            add(pk(d.subarray(88, 120)), d.readBigUInt64LE(120));
        }
    }
    const legs = [...net].filter(([, v]) => v !== 0n).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    if (legs.length < 2) return null;
    const [inMint, inNet] = legs[0], [outMint, outNet] = legs.at(-1);
    if (inNet >= 0n || outNet <= 0n) return null;
    return { inMint, inAtoms: (-inNet).toString(), outMint, outAtoms: outNet.toString(), venues: [...venues] };
}

/**
 * What a transaction did for `wallet`, or null if nothing we track. Takes a jsonParsed transaction.
 * Amounts are atom strings. Exported for tests.
 */
export function parseTransaction(tx, wallet) {
    if (!tx || tx.meta?.err) return null;
    const keys = tx.transaction.message.accountKeys.map(k => ({ key: k.pubkey?.toBase58 ? k.pubkey.toBase58() : String(k.pubkey), signer: !!k.signer }));
    if (!keys.some(k => k.key === wallet && k.signer)) return null; // only what the wallet signed
    const time = (tx.blockTime || 0) * 1000;
    const sig = tx.transaction.signatures[0];
    const ixs = executionOrder(tx);
    const logs = tx.meta?.logMessages || [];
    const out = { sig, time, feePayer: keys[0].key };
    // SpotTerminal marks its transactions with a memo; the app that called Manifest is the
    // top-level program a Manifest instruction ran under (none: called directly).
    if (ixs.some(ix => ix.program === 'spl-memo' && String(ix.parsed).includes('SpotTerminal'))) out.memo = 'SpotTerminal';
    const top = tx.transaction.message.instructions;
    const via = new Set();
    for (const g of tx.meta?.innerInstructions || []) {
        if (g.instructions.some(ix => programOf(ix) === MANIFEST)) via.add(programOf(top[g.index]));
    }
    via.delete(MANIFEST);
    if (top.some(ix => programOf(ix) === MANIFEST)) out.manifestDirect = true;
    if (via.size) out.manifestVia = [...via];

    // Manifest: batch updates (placements and cancels), from the instructions themselves (they
    // run inside wrapper programs too), and money moved, from the program's events.
    const returns = batchReturns(logs);
    let r = 0;
    const markets = new Map(); // market -> { placed, cancels }
    const entry = (market) => markets.get(market) || markets.set(market, { placed: [], cancels: [] }).get(market);
    for (const ix of ixs) {
        if (programOf(ix) !== MANIFEST || !ix.data) continue;
        const data = Buffer.from(bs58.decode(ix.data));
        if (data[0] !== BATCH_UPDATE) continue;
        const seqs = returns[r++] || [];
        const accounts = accountsOf(ix);
        if (accounts[0] !== wallet) continue;
        let params;
        try {
            params = BatchUpdateStruct.deserialize(data)[0].params;
        } catch {
            continue;
        }
        const e = entry(accounts[1]);
        e.cancels.push(...params.cancels.map(c => c.orderSequenceNumber.toString()));
        params.orders.forEach((o, i) => e.placed.push({
            seq: seqs[i] ?? null,
            isBid: o.isBid,
            baseAtoms: o.baseAtoms.toString(),
            mantissa: o.priceMantissa,
            exponent: o.priceExponent,
            lastValidSlot: o.lastValidSlot || 0,
        }));
    }
    const flows = [], takerFills = [];
    for (const { name, data } of manifestEvents(logs)) {
        if (name === 'DepositLog' || name === 'WithdrawLog') {
            if (data.trader.toBase58() !== wallet) continue;
            flows.push({ market: data.market.toBase58(), mint: data.mint.toBase58(), atoms: data.amountAtoms.toString(), dir: name === 'DepositLog' ? 'in' : 'out' });
            entry(data.market.toBase58());
        } else if (name === 'FillLog' && data.taker.toBase58() === wallet) {
            takerFills.push({
                market: data.market.toBase58(), baseAtoms: data.baseAtoms.inner.toString(), quoteAtoms: data.quoteAtoms.inner.toString(),
                takerIsBuy: data.takerIsBuy, makerSequenceNumber: data.makerSequenceNumber.toString(),
            });
            entry(data.market.toBase58());
        } else if (name === 'PlaceOrderLog' && data.trader.toBase58() === wallet) {
            // Older program versions logged placements: fill in a sequence number the return data lacked.
            const p = entry(data.market.toBase58()).placed.find(x => x.seq == null && x.baseAtoms === data.baseAtoms.inner.toString());
            if (p) p.seq = data.orderSequenceNumber.toString();
        }
    }
    if (markets.size) {
        out.manifest = [...markets].map(([market, e]) => ({
            market,
            placed: e.placed.filter(p => p.seq != null),
            cancels: e.cancels,
            flows: flows.filter(f => f.market === market),
            takerFills: takerFills.filter(f => f.market === market),
        }));
    }

    // Jupiter swaps the wallet signed.
    const swap = jupiterSwap(ixs);
    if (swap) out.swap = swap;

    // Payout (durable nonce) accounts the wallet set up (with the rent paid), advanced (a
    // pre-signed payout or a cancel used one) or closed (rent refunded).
    const nonces = { created: [], closed: [], advanced: [] };
    const funded = new Map(); // new account -> lamports the wallet put in
    for (const ix of ixs) {
        if (ix.program !== 'system' || !ix.parsed) continue;
        const { type, info } = ix.parsed;
        if (type === 'createAccount' && info.source === wallet) funded.set(info.newAccount, info.lamports);
        if (type === 'initializeNonce' && info.nonceAuthority === wallet) nonces.created.push({ address: info.nonceAccount, lamports: String(funded.get(info.nonceAccount) ?? 0) });
        if (type === 'withdrawFromNonce' && info.nonceAuthority === wallet) nonces.closed.push({ address: info.nonceAccount, lamports: String(info.lamports ?? 0) });
        if (type === 'advanceNonce' && info.nonceAuthority === wallet) nonces.advanced.push(info.nonceAccount);
    }
    if (nonces.created.length || nonces.closed.length || nonces.advanced.length) out.nonces = nonces;

    return out.manifest || out.swap || out.nonces ? out : null;
}

// ---------- scanning and caching ----------

/**
 * Transactions by signature, raw from the RPC (web3.js would refuse version-1 transactions, and
 * one of them in a batch failed the whole batch): `jsonParsed`, or `json` when only the logs matter.
 */
const fetchTransactions = (sigs, encoding = 'jsonParsed') => Promise.all(sigs.map(sig =>
    rpc('getTransaction', [sig, { encoding, maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])));

let lastFetch = 0;
/** Run an RPC call in turn with all other history calls; on a 429, back off and try again. */
async function paced(fn) {
    for (let attempt = 0; ; attempt++) {
        const wait = lastFetch + FETCH_GAP_MS - Date.now();
        lastFetch = Math.max(Date.now(), lastFetch + FETCH_GAP_MS);
        if (wait > 0) await sleep(wait);
        try {
            return await fn();
        } catch (err) {
            if (!/429|Too Many Requests/i.test(err.message) || attempt >= 4) throw err;
            lastFetch = Date.now() + 2000 * 2 ** attempt; // 2s, 4s, 8s, 16s: everyone waits
        }
    }
}

export class ChainHistory {
    constructor() {
        this.dir = path.join(config.dataDir, 'history');
        this.states = new Map();   // wallet -> cached state
        this.scanning = new Map(); // wallet -> promise
    }

    file(wallet) {
        return path.join(this.dir, `${wallet}.json`);
    }

    state(wallet) {
        let s = this.states.get(wallet);
        if (s) return s;
        try {
            s = JSON.parse(fs.readFileSync(this.file(wallet), 'utf8'));
            if (s.version !== VERSION) s = null;
        } catch {
            s = null;
        }
        s ||= { version: VERSION, newest: null, oldest: null, done: false, scanned: 0, items: [] };
        s.fills ||= {}; // `${market}:${seq}` -> { baseAtoms, quoteAtoms, time } | { busy: true }
        this.states.set(wallet, s);
        return s;
    }

    save(wallet) {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${this.file(wallet)}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.state(wallet)));
            fs.renameSync(tmp, this.file(wallet));
        } catch (err) {
            log.warn('history', 'save_failed', { wallet: short(wallet), msg: err.message });
        }
    }

    /** The cached items now, and a scan started in the background if there's anything new. */
    get(wallet) {
        if (!this.scanning.has(wallet)) {
            const p = this.scan(wallet).catch(err => log.warn('history', 'scan_failed', { wallet: short(wallet), msg: errorDetail(err) }))
                .finally(() => this.scanning.delete(wallet));
            this.scanning.set(wallet, p);
        }
        const s = this.state(wallet);
        return { items: s.items, fills: s.fills, scanning: this.scanning.has(wallet), done: s.done, scanned: s.scanned, sinceDays: HISTORY_DAYS };
    }

    async scan(wallet) {
        const s = this.state(wallet);
        const owner = new PublicKey(wallet);
        // Newer transactions first (since the newest one seen), then further back until the cutoff.
        let newer = [];
        if (s.newest) {
            let before;
            for (;;) {
                const page = await paced(() => connection.getSignaturesForAddress(owner, { until: s.newest, before, limit: 1000 }));
                newer.push(...page);
                if (page.length < 1000) break;
                before = page.at(-1).signature;
            }
            if (newer.length) await this.process(wallet, newer);
            if (newer.length) s.newest = newer[0].signature;
        }
        const cutoff = Date.now() / 1000 - HISTORY_DAYS * 86400;
        while (!s.done) {
            const page = await paced(() => connection.getSignaturesForAddress(owner, { before: s.oldest || undefined, limit: 200 }));
            if (!s.newest && page.length) s.newest = page[0].signature;
            const inRange = page.filter(p => (p.blockTime || 0) >= cutoff);
            await this.process(wallet, inRange);
            if (page.length) s.oldest = page.at(-1).signature;
            if (page.length < 200 || inRange.length < page.length) s.done = true;
            this.save(wallet);
        }
        await this.scanCancelledFills(wallet);
        this.save(wallet);
    }

    /**
     * Exact fills of the wallet's cancelled orders: the FillLogs naming it as maker in the market's
     * transactions between the order's placement and its cancel (on quiet markets; on busy ones
     * deriveHistory estimates from payouts and the cancel's own withdrawal).
     */
    async scanCancelledFills(wallet) {
        const s = this.state(wallet);
        const placedAt = new Map(), todo = [];
        for (const item of [...s.items].sort((a, b) => a.time - b.time)) {
            for (const m of item.manifest || []) {
                for (const p of m.placed) placedAt.set(`${m.market}:${p.seq}`, item.sig);
                for (const seq of m.cancels) {
                    const key = `${m.market}:${seq}`;
                    if (placedAt.has(key) && !s.fills[key]) todo.push({ key, market: m.market, seq, from: placedAt.get(key), to: item.sig });
                }
            }
        }
        for (const t of todo) {
            const sigs = await paced(() => connection.getSignaturesForAddress(new PublicKey(t.market), { before: t.to, until: t.from, limit: FILL_SCAN_MAX + 1 }));
            if (sigs.length > FILL_SCAN_MAX) {
                s.fills[t.key] = { busy: true };
                continue;
            }
            let base = 0n, quote = 0n, time = null;
            const list = sigs.filter(x => !x.err).map(x => x.signature);
            for (let i = 0; i < list.length; i += FETCH_BATCH) {
                const txs = await paced(() => fetchTransactions(list.slice(i, i + FETCH_BATCH), 'json'));
                for (const tx of txs) {
                    for (const f of parseFills(tx?.meta?.logMessages)) {
                        if (f.maker !== wallet || f.market !== t.market || f.makerSequenceNumber !== t.seq) continue;
                        base += f.baseAtoms;
                        quote += f.quoteAtoms;
                        time = Math.max(time ?? 0, (tx.blockTime || 0) * 1000);
                    }
                }
            }
            s.fills[t.key] = { baseAtoms: base.toString(), quoteAtoms: quote.toString(), time };
            this.save(wallet);
        }
    }

    async process(wallet, sigs) {
        const s = this.state(wallet);
        const todo = sigs.filter(x => !x.err).map(x => x.signature);
        const seen = new Set(s.items.map(i => i.sig));
        for (let i = 0; i < todo.length; i += FETCH_BATCH) {
            const batch = todo.slice(i, i + FETCH_BATCH).filter(sig => !seen.has(sig));
            if (!batch.length) continue;
            const txs = await paced(() => fetchTransactions(batch));
            for (const tx of txs) {
                let item = null;
                try {
                    item = parseTransaction(tx, wallet);
                } catch (err) {
                    log.warn('history', 'parse_failed', { sig: tx?.transaction?.signatures?.[0]?.slice(0, 12), msg: err.message });
                }
                if (item) s.items.push(item);
            }
            s.scanned += batch.length;
        }
        s.items.sort((a, b) => b.time - a.time);
    }
}

// ---------- from transactions to orders and trades ----------

// Apps that place Manifest orders through a program of their own, and DEXs Jupiter routes through.
const APP_NAMES = { wMNFSTkir3HgyZTsB7uqu3i7FA73grFCptPXgrZjksL: 'manifest.trade', ...AGGREGATOR_PROGRAM_IDS };
const DEX_NAMES = {
    MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms: 'Manifest',
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
    Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora',
    cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
    CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
    PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: 'Phoenix',
    opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: 'OpenBook',
    SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe: 'SolFi',
    ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY: 'ZeroFi',
    TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH: 'Tessera V',
    '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp': 'HumidiFi',
    obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y: 'Obric',
    '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXYEGPjr1kxbMcuR': 'Lifinity',
};
const dexName = (id) => DEX_NAMES[id] || `${id.slice(0, 4)}…`;

/**
 * Which of a wallet's transactions were SpotTerminal's, by signature. Since late October 2026 each
 * carries the "SpotTerminal" memo. Before that: whatever set up, advanced or closed one of its
 * payout (nonce) accounts (SpotTerminal's setup, payouts, cancels and edits), and calls straight
 * to Manifest (not through another app's program) once those accounts existed: its placements.
 */
export function spotTerminalSignatures(items) {
    const out = new Set();
    let payoutAccountsSince = Infinity;
    for (const item of [...items].sort((a, b) => a.time - b.time)) {
        const n = item.nonces;
        if (n?.created.length) payoutAccountsSince = Math.min(payoutAccountsSince, item.time);
        if (item.memo === 'SpotTerminal' || n?.created.length || n?.closed.length || n?.advanced.length
            || (item.manifestDirect && !item.manifestVia && item.time >= payoutAccountsSince)) out.add(item.sig);
    }
    return out;
}

const QUOTE_PREFERENCE = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'So11111111111111111111111111111111111111112',  // SOL
];

/**
 * The wallet's orders and trades from its cached transactions, with each order's state now:
 *   open / expired  still on the book (filled = size minus what's left),
 *   cancelled       the wallet cancelled it (filled unknown, except what matched on arrival),
 *   expired         past its last valid slot and gone,
 *   filled          gone from the book otherwise: only a complete fill removes an order.
 * `markets`: ManifestMarkets; `decimals(mint)` and `symbol(mint)` from the token registry.
 */
export function deriveHistory(items, { markets, decimals, symbol, wallet = null, fills = {} }) {
    const spotTerminal = spotTerminalSignatures(items);
    const appOf = (item) => (spotTerminal.has(item.sig) ? 'SpotTerminal' : item.manifestVia?.map(p => APP_NAMES[p]).find(Boolean) || null);
    const orders = new Map();   // `${market}:${seq}` -> order
    const cancelled = new Map(); // `${market}:${seq}` -> { time, sig }
    // Proceeds coming back out of each market, and what kind of transaction took them: a payout
    // (paid by someone else: the keeper), a cancel (with the orders it cancelled), or a withdraw.
    const withdrawals = new Map(); // market -> [{ time, sig, mint, atoms, kind, cancels }]
    const trades = [];
    for (const item of [...items].sort((a, b) => a.time - b.time)) {
        for (const m of item.manifest || []) {
            const kind = wallet && item.feePayer !== wallet ? 'payout' : m.cancels.length ? 'cancel' : m.placed.length ? 'other' : 'withdraw';
            for (const f of m.flows) {
                if (f.dir !== 'out') continue;
                (withdrawals.get(m.market) || withdrawals.set(m.market, []).get(m.market))
                    .push({ time: item.time, sig: item.sig, mint: f.mint, atoms: BigInt(f.atoms), kind, cancels: m.cancels });
            }
            for (const seq of m.cancels) cancelled.set(`${m.market}:${seq}`, { time: item.time, sig: item.sig });
            const matched = m.takerFills.reduce((s, f) => s + BigInt(f.baseAtoms), 0n);
            m.placed.forEach((p, i) => orders.set(`${m.market}:${p.seq}`, {
                market: m.market, sequenceNumber: p.seq, isBid: p.isBid, baseAtoms: BigInt(p.baseAtoms),
                mantissa: p.mantissa, exponent: p.exponent, lastValidSlot: p.lastValidSlot,
                time: item.time, sig: item.sig, matchedAtoms: i === 0 ? matched : 0n, app: appOf(item),
            }));
            // Fills with no order placed: a market order straight on Manifest (its Swap instruction).
            if (!m.placed.length && m.takerFills.length) {
                const base = m.takerFills.reduce((s, f) => s + BigInt(f.baseAtoms), 0n);
                const quote = m.takerFills.reduce((s, f) => s + BigInt(f.quoteAtoms), 0n);
                trades.push({ kind: 'manifest', time: item.time, sig: item.sig, market: m.market, isBuy: m.takerFills[0].takerIsBuy, baseAtoms: base, quoteAtoms: quote, app: appOf(item) });
            }
        }
        if (item.swap) trades.push({ kind: 'jupiter', time: item.time, sig: item.sig, ...item.swap, app: spotTerminal.has(item.sig) ? 'SpotTerminal' : null });
    }

    // Each payout is one order's proceeds (all of them, or at least 90% for a near-full payout):
    // give it to the earliest unpaid order in that market whose proceeds it fits.
    const paidOut = new Map(); // order -> atoms of its proceeds paid out
    const proceedsOf = (o) => {
        const s = markets.summary(o.market);
        if (!s) return null;
        return { mint: o.isBid ? s.baseMint : s.quoteMint, atoms: o.isBid ? o.baseAtoms : quoteForBase(o.mantissa, o.exponent, o.baseAtoms, false) };
    };
    for (const [market, list] of withdrawals) {
        for (const w of list.filter(x => x.kind === 'payout')) {
            const fits = [...orders.values()].filter((o) => {
                const p = o.market === market && !paidOut.has(o) && o.time <= w.time && proceedsOf(o);
                return p && p.mint === w.mint && w.atoms <= p.atoms && w.atoms * 10n >= p.atoms * 9n;
            });
            const best = fits.sort((a, b) => a.time - b.time)[0];
            if (best) {
                paidOut.set(best, w.atoms);
                w.order = best;
            }
        }
    }

    const outOrders = [];
    const restingIn = new Map(); // market -> Map(seq -> resting order); parsing a market is costly
    const restingOrder = (market, seq) => {
        if (!restingIn.has(market)) restingIn.set(market, new Map(markets.allOrders(market).map(r => [r.sequenceNumber.toString(), r])));
        return restingIn.get(market).get(seq);
    };
    for (const o of orders.values()) {
        const s = markets.summary(o.market);
        const baseDecimals = s?.baseDecimals ?? decimals(s?.baseMint), quoteDecimals = s?.quoteDecimals ?? decimals(s?.quoteMint);
        if (!s || baseDecimals == null || quoteDecimals == null) continue;
        const key = `${o.market}:${o.sequenceNumber}`;
        const resting = restingOrder(o.market, o.sequenceNumber);
        const expiredBySlot = o.lastValidSlot && o.lastValidSlot < markets.slot;
        const size = Number(o.baseAtoms) / 10 ** baseDecimals;
        let status, filledAtoms = null, remaining = null, closedAt = null;
        if (resting) {
            const left = BigInt(resting.numBaseAtoms.toString());
            remaining = Number(left) / 10 ** baseDecimals;
            filledAtoms = o.baseAtoms - left;
            status = expiredBySlot ? 'expired' : 'open';
        } else if (cancelled.has(key)) {
            const c = cancelled.get(key);
            status = 'cancelled';
            closedAt = c.time;
            filledAtoms = o.matchedAtoms > 0n ? o.matchedAtoms : null;
            // What it filled before the cancel came back in its proceeds token (base for a bid, quote
            // for an ask): its payout, the proceeds its own cancel withdrew (SpotTerminal's cancels
            // withdraw; when it cancelled only this order), and withdrawals in between, counted only
            // when no other order of the wallet's on the same side was open then (they'd share them).
            const exact = fills[key];
            if (exact && !exact.busy) {
                // Read from its takers' transactions (ChainHistory.scanCancelledFills): exact.
                filledAtoms = o.matchedAtoms + BigInt(exact.baseAtoms);
            } else {
                // A busy market: estimate from what came back in its proceeds token (base for a bid,
                // quote for an ask): its payout, and the proceeds its own cancel withdrew
                // (SpotTerminal's cancels withdraw), when that cancel was for this order alone.
                const proceeds = o.isBid ? s.baseMint : s.quoteMint;
                let out = paidOut.get(o) || 0n;
                for (const w of withdrawals.get(o.market) || []) {
                    if (w.mint !== proceeds || w.time < o.time || w.time > c.time || w.order) continue;
                    if (w.kind === 'cancel' && w.sig === c.sig && w.cancels.length === 1) out += w.atoms;
                }
                const base = o.isBid ? out : BigInt(Math.floor(Number(out) / (o.mantissa * 10 ** o.exponent)));
                if (base > 0n) filledAtoms = base < o.baseAtoms ? base : o.baseAtoms;
            }
        } else if (expiredBySlot) {
            status = 'expired';
        } else {
            status = 'filled';
            filledAtoms = o.baseAtoms;
        }
        outOrders.push({
            id: `chain:${key}`,
            source: 'chain',
            venue: 'Manifest',
            app: o.app,
            market: o.market,
            symbol: `${symbol(s.baseMint)}/${symbol(s.quoteMint)}`,
            baseMint: s.baseMint,
            quoteMint: s.quoteMint,
            side: o.isBid ? 'buy' : 'sell',
            isBid: o.isBid,
            price: o.mantissa * 10 ** o.exponent * 10 ** (baseDecimals - quoteDecimals),
            size,
            remaining,
            filled: filledAtoms == null ? null : Number(filledAtoms) / 10 ** baseDecimals,
            sequenceNumber: o.sequenceNumber,
            status,
            createdAt: o.time,
            closedAt,
            placeSignature: o.sig,
        });
    }

    const outTrades = trades.map((t) => {
        if (t.kind === 'manifest') {
            const s = markets.summary(t.market);
            if (!s) return null;
            const base = Number(t.baseAtoms) / 10 ** s.baseDecimals, quote = Number(t.quoteAtoms) / 10 ** s.quoteDecimals;
            return { id: `trade:${t.sig}`, venue: 'manifest', app: t.app, market: t.market, symbol: `${symbol(s.baseMint)}/${symbol(s.quoteMint)}`, side: t.isBuy ? 'buy' : 'sell', size: base, price: base ? quote / base : null, createdAt: t.time, signature: t.sig };
        }
        // A Jupiter swap as a trade of base against quote: quote is USDC, USDT or SOL when one side is.
        // DEXs by name, recognised ones only (older events' fields vary).
        const inDec = decimals(t.inMint), outDec = decimals(t.outMint);
        if (inDec == null || outDec == null) return null;
        const inAmount = Number(t.inAtoms) / 10 ** inDec, outAmount = Number(t.outAtoms) / 10 ** outDec;
        const rank = (m) => { const i = QUOTE_PREFERENCE.indexOf(m); return i < 0 ? Infinity : i; };
        const buy = rank(t.inMint) <= rank(t.outMint); // paid with the quote token: bought the base
        const [baseMint, quoteMint, base, quote] = buy ? [t.outMint, t.inMint, outAmount, inAmount] : [t.inMint, t.outMint, inAmount, outAmount];
        return { id: `trade:${t.sig}`, venue: 'jupiter', app: t.app, dexes: [...new Set(t.venues.filter(v => DEX_NAMES[v]).map(dexName))], symbol: `${symbol(baseMint)}/${symbol(quoteMint)}`, baseMint, quoteMint, side: buy ? 'buy' : 'sell', size: base, price: base ? quote / base : null, createdAt: t.time, signature: t.sig };
    }).filter(Boolean);

    // Payout accounts the wallet set up and hasn't closed (still to be checked on-chain).
    const nonces = new Set();
    for (const item of [...items].sort((a, b) => a.time - b.time)) {
        for (const a of item.nonces?.created || []) nonces.add(a.address);
        for (const a of item.nonces?.closed || []) nonces.delete(a.address);
    }

    return {
        orders: outOrders.sort((a, b) => b.createdAt - a.createdAt),
        trades: outTrades.sort((a, b) => b.createdAt - a.createdAt),
        payoutAccounts: [...nonces],
    };
}

// ---------- for the tax export ----------

const SOL = 'So11111111111111111111111111111111111111112';

/**
 * SpotTerminal's activity as tax-ledger entries (the shape orders/ledger.js keeps), from the chain:
 * money moving into and out of SpotTerminal (order funds deposited into Manifest, payouts and
 * withdrawals, payout-account rent set aside and refunded, marked `rent`) and its limit orders'
 * fills as trades. Only SpotTerminal's transactions count (spotTerminalSignatures). Jupiter swaps
 * stay out: they're ordinary wallet trades that the tax apps' own Solana import already has.
 *
 * Fill dates: a fill on arrival is dated when the order was placed. A fill against the resting
 * order happens in the taker's transaction, so it's dated when it first shows in the wallet's: when
 * its proceeds were paid out, or came back with a cancel or a withdraw. Until then it isn't listed.
 */
export function deriveTaxEntries(items, { wallet, markets, fills = {} }) {
    const spotTerminal = spotTerminalSignatures(items);
    const mine = [...items].filter(i => spotTerminal.has(i.sig)).sort((a, b) => a.time - b.time);
    const entries = [];

    for (const item of mine) {
        const manifest = item.manifest || [];
        const moves = [
            ...(item.nonces?.created || []).filter(n => n.lamports !== '0').map(n => ({ mint: SOL, atoms: n.lamports, dir: 'in', rent: true })),
            ...(item.nonces?.closed || []).map(n => ({ mint: SOL, atoms: n.lamports, dir: 'out', rent: true })),
            ...manifest.flatMap(m => m.flows.map(f => ({ mint: f.mint, atoms: f.atoms, dir: f.dir }))),
        ];
        if (!moves.length) continue;
        const placed = manifest.some(m => m.placed.length), cancelled = manifest.some(m => m.cancels.length);
        const kind = !manifest.length ? (item.nonces?.created.length ? 'setup' : 'closePayout')
            : item.nonces?.closed.length ? 'closeAccount'
                : item.feePayer !== wallet ? 'claim'
                    : placed ? (cancelled ? 'edit' : 'place')
                        : cancelled ? 'cancel' : 'withdraw';
        entries.push({ key: `${kind}:${item.sig}`, wallet, kind, at: item.time, sig: item.sig, moves });
    }

    // Fills of SpotTerminal's orders: what matched on arrival, then the rest of what the chain says
    // filled (deriveHistory), dated by the first settlement.
    const filledByKey = new Map(deriveHistory(items, { markets, decimals: () => null, symbol: () => '', wallet, fills }).orders
        .map(o => [`${o.market}:${o.sequenceNumber}`, o.filled]));
    for (const item of mine) {
        for (const m of item.manifest || []) {
            const s = markets.summary(m.market);
            if (!s) continue;
            m.placed.forEach((p, i) => {
                const side = p.isBid ? 'buy' : 'sell';
                const tokenPrice = p.mantissa * 10 ** p.exponent * 10 ** (s.baseDecimals - s.quoteDecimals);
                const trade = (baseAtoms, quoteAtoms, price) => ({ side, baseMint: s.baseMint, quoteMint: s.quoteMint, baseAtoms: baseAtoms.toString(), quoteAtoms: quoteAtoms.toString(), price });
                const orderId = `${m.market}:${p.seq}`;
                const matched = i === 0 ? m.takerFills : [];
                const matchedBase = matched.reduce((t, f) => t + BigInt(f.baseAtoms), 0n);
                if (matchedBase > 0n) {
                    const matchedQuote = matched.reduce((t, f) => t + BigInt(f.quoteAtoms), 0n);
                    entries.push({ key: `fill:${orderId}:arrival`, wallet, kind: 'fill', at: item.time, orderId, moves: [],
                        trade: trade(matchedBase, matchedQuote, Number(matchedQuote) / Number(matchedBase) * 10 ** (s.baseDecimals - s.quoteDecimals)) });
                }
                // Read from its takers' transactions: the exact amounts, dated at the last fill.
                const exact = fills[orderId];
                if (exact && !exact.busy) {
                    if (BigInt(exact.baseAtoms) > 0n) {
                        entries.push({ key: `fill:${orderId}`, wallet, kind: 'fill', at: exact.time, orderId, moves: [],
                            trade: trade(BigInt(exact.baseAtoms), BigInt(exact.quoteAtoms), tokenPrice) });
                    }
                    return;
                }
                const filled = filledByKey.get(orderId);
                if (filled == null) return;
                const restBase = BigInt(Math.round(filled * 10 ** s.baseDecimals)) - matchedBase;
                if (restBase <= 0n) return;
                const proceeds = p.isBid ? s.baseMint : s.quoteMint;
                const settled = mine.find(x => x.time > item.time && (x.manifest || []).some(mm => mm.market === m.market
                    && mm.flows.some(f => f.dir === 'out' && f.mint === proceeds)));
                if (!settled) return;
                // A second before the settlement that paid it out, so the trade comes first in the
                // CSVs (dated to the second) and the tokens it bought are never sent before held.
                // Quote rounded down, as Manifest rounds each fill.
                entries.push({ key: `fill:${orderId}`, wallet, kind: 'fill', at: settled.time - 1000, orderId, moves: [],
                    trade: trade(restBase, quoteForBase(p.mantissa, p.exponent, restBase, false), tokenPrice) });
            });
        }
    }
    return entries.sort((a, b) => a.at - b.at);
}
