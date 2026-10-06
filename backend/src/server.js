import fs from 'fs';
import path from 'path';
import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from './config.js';
import { connection } from './solana.js';
import { TokenRegistry } from './tokens/tokenRegistry.js';
import { ManifestMarkets } from './venues/manifest/markets.js';
import { ArcherVenue } from './venues/archer/archer.js';
import { TradeStore, SUPPORTED_RESOLUTIONS } from './marketdata/tradeStore.js';
import { OrderStore } from './orders/orderStore.js';
import { OrderService, UserError } from './orders/orderService.js';
import { Keeper, loadKeeperKeypair } from './orders/keeper.js';
import { aggregateBook } from './marketdata/aggregate.js';
import { GeckoStats } from './marketdata/geckoStats.js';
import { errorDetail, log, short, takeProblemCounts } from './log.js';
import { takeRpcStats } from './rpcStats.js';
import { startLogRotation } from './logRotate.js';

const registry = new TokenRegistry({ heliusRpc: config.rpcUrl, jupApiKey: config.jupApiKey });
registry.startBackgroundRefresh();

const markets = new ManifestMarkets();
const archer = new ArcherVenue();
// Every open market stream listens to these; the default warning at 10 listeners would misfire.
markets.setMaxListeners(0);
archer.setMaxListeners(0);
const MIN_TRADE_USD = 0.5;
const trades = new TradeStore(markets, (market) => {
    const quoteUsd = registry.cachedPrice(markets.summary(market)?.quoteMint);
    return quoteUsd ? MIN_TRADE_USD / quoteUsd : 0;
});
trades.setMaxListeners(0);
const orderStore = new OrderStore();
const keeperKeypair = loadKeeperKeypair();
/** Market price for a pair from Jupiter's USD prices (deep, cross-venue), or null if either is unpriced. */
async function referencePrice(address) {
    const s = markets.summary(address);
    if (!s) return null;
    const prices = await registry.getPrices([s.baseMint, s.quoteMint]);
    const base = prices[s.baseMint], quote = prices[s.quoteMint];
    return base > 0 && quote > 0 ? base / quote : null;
}

const orders = new OrderService({
    markets, store: orderStore, keeperPubkey: keeperKeypair.publicKey, referencePrice,
    jupiter: (path, init) => registry.jupFetch(path, init),
});
const keeper = new Keeper({ markets, store: orderStore, keypair: keeperKeypair });
orders.onPlaced = (id) => keeper.track(id);

markets.on('fills', (address, fills) => {
    const time = Date.now();
    for (const fill of fills) trades.addTrade(address, fill, time);
});

await markets.startScanning();
// Token metadata for everything listed on Manifest (cached on disk after the first run).
registry.ensure([...new Set(markets.allSummaries().flatMap(s => [s.baseMint, s.quoteMint]))])
    .catch(err => log.warn('tokens', 'resolve_failed', { msg: err.message }));
keeper.start();
startLogRotation(path.join(config.root, 'logs'));
archer.start();
const gecko = new GeckoStats(markets);
gecko.start();

// ---------------------------------------------------------------------------

// 24h high/low for markets being viewed, from GeckoTerminal hourly bars plus our own fills,
// until our own candles cover a full day. Refreshed in the background; never blocks a request.
const hiLoCache = new Map(); // market -> { high, low, at }
function hiLo(address, st) {
    if (st.coverageHours >= 23) return { high: st.high24h, low: st.low24h };
    const hit = hiLoCache.get(address);
    // Refresh every 5 minutes; retry sooner if the last attempt produced nothing.
    const maxAge = hit?.high != null ? 5 * 60 * 1000 : 30 * 1000;
    if (!hit || Date.now() - hit.at > maxAge) {
        hiLoCache.set(address, { ...(hit || {}), at: Date.now() });
        const now = Math.floor(Date.now() / 1000);
        trades.bars(address, '60', now - 86400, now + 3600).then(bars => {
            if (!bars.length) return;
            hiLoCache.set(address, {
                high: Math.max(...bars.map(b => b.high)),
                low: Math.min(...bars.map(b => b.low)),
                at: Date.now(),
            });
        }).catch(() => {});
    }
    const cached = hiLoCache.get(address);
    return {
        high: cached?.high != null ? Math.max(cached.high, st.high24h ?? -Infinity) : st.high24h,
        low: cached?.low != null ? Math.min(cached.low, st.low24h ?? Infinity) : st.low24h,
    };
}

function marketView(s, { withHiLo = false } = {}) {
    const base = registry.display(s.baseMint);
    const quote = registry.display(s.quoteMint);
    const st = trades.stats(s.address);
    const mid = s.bestBid && s.bestAsk ? (s.bestBid + s.bestAsk) / 2 : null;
    const last = st.last ?? mid;
    // Our own counters are exact once they span a day; until then use GeckoTerminal's 24h figures.
    const ownFullDay = (s.volumeWindowHours ?? 0) >= 23;
    const gt = gecko.get(s.address);
    let volume24hQuote = s.volume24hAtoms != null ? s.volume24hAtoms / 10 ** s.quoteDecimals : null;
    let volume24hUsd = volume24hQuote != null && quote.usdPrice ? volume24hQuote * quote.usdPrice : null;
    if (!ownFullDay && gt?.volume24hUsd != null) {
        volume24hUsd = gt.volume24hUsd;
        volume24hQuote = quote.usdPrice ? gt.volume24hUsd / quote.usdPrice : null;
    }
    const ownChange = st.open24h && last && st.coverageHours >= 23 ? last / st.open24h - 1 : null;
    return {
        address: s.address,
        venue: s.venue,
        symbol: `${base.symbol}/${quote.symbol}`,
        base: { mint: s.baseMint, symbol: base.symbol, name: base.name, icon: base.icon, decimals: s.baseDecimals, verified: base.verified, usdPrice: base.usdPrice },
        quote: { mint: s.quoteMint, symbol: quote.symbol, name: quote.name, icon: quote.icon, decimals: s.quoteDecimals, verified: quote.verified, usdPrice: quote.usdPrice },
        bestBid: s.bestBid,
        bestAsk: s.bestAsk,
        last,
        change24h: ownChange ?? gt?.change24h ?? (st.open24h && last ? last / st.open24h - 1 : null),
        ...(withHiLo ? (({ high, low }) => ({ high24h: high, low24h: low }))(hiLo(s.address, st)) : { high24h: st.high24h, low24h: st.low24h }),
        volume24hQuote,
        volume24hUsd,
        volumeWindowHours: ownFullDay || gt?.volume24hUsd == null ? (s.volumeWindowHours ?? null) : 24,
        orders: s.bidCount + s.askCount,
    };
}

/** Aggregated book with sub-cent dust levels removed. */
const MAX_ARCHER_PAIR_MARKETS = 3;
const archerPairMarkets = (s) => archer.marketsForPair(s.baseMint, s.quoteMint).slice(0, MAX_ARCHER_PAIR_MARKETS);

function bookFor(s, depth) {
    const quoteUsd = registry.cachedPrice(s.quoteMint);
    const extra = archerPairMarkets(s).map(m => ({ venue: 'archer', market: m.address, baseMint: m.baseMint, levels: archer.levels(m.address) }));
    return aggregateBook(markets, s, depth, quoteUsd ? 0.01 / quoteUsd : 0, extra);
}

function requireMarket(req, res) {
    const s = markets.summary(req.params.address);
    if (!s) {
        res.status(404).json({ error: 'Market not found' });
        return null;
    }
    return s;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---------- per-IP limits (each of these costs RPC credits) ----------
// Behind Cloudflare -> nginx, the visitor is in CF-Connecting-IP (nginx passes it through).
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown');
const buckets = new Map(); // `${name}|${ip}` -> { count, resetAt }
// Forget expired counters, so IPs aren't kept in memory past their window (the Privacy Policy says so).
setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (now >= b.resetAt) buckets.delete(key);
}, 60_000).unref();
function rateLimit(name, max, windowMs) {
    return (req, res, next) => {
        const key = `${name}|${clientIp(req)}`;
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now >= b.resetAt) buckets.set(key, (b = { count: 0, resetAt: now + windowMs }));
        if (++b.count > max) {
            res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
            return res.status(429).json({ error: 'Too many requests, slow down a little.' });
        }
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}, 60_000).unref();
const streamsPerIp = new Map();
const MAX_STREAMS_PER_IP = 8;

app.get('/api/config', (req, res) => {
    res.json({ keeper: keeperKeypair.publicKey.toBase58(), resolutions: SUPPORTED_RESOLUTIONS });
});

app.get('/api/markets', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(500, Number(req.query.limit) || 200);
    // Empty markets only show up when searched for by exact mint or address (e.g. one just created).
    const exactHit = (s) => q && (s.baseMint === req.query.q || s.quoteMint === req.query.q || s.address === req.query.q);
    // ?addresses=a,b,c: exactly those markets (favourites), whatever their activity.
    if (req.query.addresses) {
        const wanted = String(req.query.addresses).split(',').slice(0, 100);
        res.set('Cache-Control', 'no-cache');
        return res.json({ markets: wanted.map(a => markets.summary(a)).filter(Boolean).map(marketView) });
    }
    // A verified token searched by its exact symbol also shows its markets that have no orders yet,
    // so "SKIRM" finds a freshly created SKIRM market.
    const namedEmpty = (s) => {
        if (!q) return false;
        const t = registry.get(s.baseMint);
        return !!t?.verified && (t.symbol || '').toLowerCase() === q;
    };
    let list = markets.allSummaries().filter(s => s.bidCount + s.askCount > 0 || exactHit(s) || namedEmpty(s)).map(marketView);
    if (q) list = list.filter(m => m.symbol.toLowerCase().includes(q) || m.base.mint === req.query.q || m.address === req.query.q);
    // ?quote=<mint>: only pairs quoted in that token (the SOL / USDC filter).
    if (req.query.quote) list = list.filter(m => m.quote.mint === req.query.quote);
    // Exact token matches first (so "JUP" finds JUP before JupSOL), then verified pairs with
    // real 24h activity.
    const exact = (m) => Number(!!q && (m.base.symbol.toLowerCase() === q || m.base.mint === req.query.q));
    list.sort((a, b) =>
        (exact(b) - exact(a)) ||
        (Number(b.base.verified && b.quote.verified) - Number(a.base.verified && a.quote.verified)) ||
        ((b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)) || (b.orders - a.orders));
    res.set('Cache-Control', 'public, max-age=5');
    res.json({ markets: list.slice(0, limit), total: list.length });
});

app.get('/api/markets/:address', (req, res) => {
    const s = requireMarket(req, res);
    if (s) res.json(marketView(s, { withHiLo: true }));
});

app.get('/api/markets/:address/book', (req, res) => {
    const s = requireMarket(req, res);
    if (!s) return;
    res.set('Cache-Control', 'no-cache');
    res.json(bookFor(s, Number(req.query.depth) || 60));
});

app.get('/api/markets/:address/reference', rateLimit('reference', 60, 60_000), async (req, res) => {
    if (!requireMarket(req, res)) return;
    try {
        res.set('Cache-Control', 'no-cache');
        res.json({ price: await referencePrice(req.params.address), source: 'Jupiter', at: Date.now() });
    } catch {
        res.json({ price: null, source: 'Jupiter', at: Date.now() });
    }
});

app.get('/api/markets/:address/trades', (req, res) => {
    if (!requireMarket(req, res)) return;
    res.json({ trades: trades.recentTrades(req.params.address, Math.min(200, Number(req.query.limit) || 60)) });
});

app.get('/api/markets/:address/candles', rateLimit('candles', 60, 60_000), async (req, res) => {
    if (!requireMarket(req, res)) return;
    const { resolution, from, to } = req.query;
    try {
        res.json({ bars: await trades.bars(req.params.address, resolution, Number(from), Number(to)) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Live stream for one market: book snapshots (throttled), trades, ticker.
app.get('/api/stream', (req, res) => {
    const address = String(req.query.market || '');
    const s = markets.summary(address);
    if (!s) return res.status(404).end();
    const ip = clientIp(req);
    if ((streamsPerIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) return res.status(429).end();
    streamsPerIp.set(ip, (streamsPerIp.get(ip) || 0) + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const release = markets.subscribe(address);
    const pairMarkets = markets.marketsForPair(s.baseMint, s.quoteMint).slice(0, 5).map(m => m.address).filter(a => a !== address);
    const releasePair = pairMarkets.map(a => markets.subscribe(a));
    const archerMarkets = archerPairMarkets(s).map(m => m.address);
    const releaseArcher = archerMarkets.map(a => archer.subscribe(a));
    let bookTimer = null;
    const pushBook = () => {
        bookTimer = null;
        send('book', bookFor(markets.summary(address), 60));
    };
    const onUpdate = (a) => {
        if ((a === address || pairMarkets.includes(a) || archerMarkets.includes(a)) && !bookTimer) bookTimer = setTimeout(pushBook, 200);
    };
    const onTrade = (m, trade) => {
        if (m === address) send('trade', trade);
    };
    markets.on('update', onUpdate);
    archer.on('update', onUpdate);
    trades.on('trade', onTrade);
    pushBook();
    const ticker = setInterval(() => send('ticker', marketView(markets.summary(address), { withHiLo: true })), 5000);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        const left = (streamsPerIp.get(ip) || 1) - 1;
        if (left > 0) streamsPerIp.set(ip, left); else streamsPerIp.delete(ip);
        markets.off('update', onUpdate);
        archer.off('update', onUpdate);
        trades.off('trade', onTrade);
        clearTimeout(bookTimer);
        clearInterval(ticker);
        clearInterval(ping);
        release();
        releasePair.forEach(r => r());
        releaseArcher.forEach(r => r());
    });
});

// Account view for one wallet on one market: wallet balances, balances held in the market, orders.
app.get('/api/account', rateLimit('account', 40, 60_000), async (req, res) => {
    let walletPk;
    try {
        walletPk = new PublicKey(String(req.query.wallet));
    } catch {
        return res.status(400).json({ error: 'Invalid wallet' });
    }
    const wallet = walletPk.toBase58();
    const address = String(req.query.market || '');
    const s = markets.summary(address);
    const out = { orders: orderStore.forWallet(wallet).slice(0, 100).map(publicOrder), wallet: null, inMarket: null };
    if (s) {
        const market = markets.get(address);
        const walletBalances = await walletTokenBalances(walletPk, [s.baseMint, s.quoteMint], { [s.baseMint]: s.baseDecimals, [s.quoteMint]: s.quoteDecimals });
        out.wallet = { base: walletBalances[s.baseMint] ?? 0, quote: walletBalances[s.quoteMint] ?? 0 };
        if (market?.hasSeat(walletPk)) {
            out.inMarket = {
                base: Number(market.getWithdrawableBalanceAtoms(walletPk, true)) / 10 ** s.baseDecimals,
                quote: Number(market.getWithdrawableBalanceAtoms(walletPk, false)) / 10 ** s.quoteDecimals,
            };
        }
        // Mark which open orders are still resting, with how much is left.
        const resting = new Map([...(market?.bids() || []), ...(market?.asks() || [])]
            .map(o => [o.sequenceNumber.toString(), Number(o.numBaseTokens)]));
        for (const o of out.orders) {
            if (o.market === address && o.sequenceNumber) o.remaining = resting.get(o.sequenceNumber) ?? 0;
        }
    }
    res.set('Cache-Control', 'no-cache');
    res.json(out);
});

function publicOrder(o) {
    const { claimTx, ...rest } = o;
    const symbol = `${registry.display(o.baseMint).symbol}/${registry.display(o.quoteMint).symbol}`;
    return { ...rest, symbol, size: Number(o.baseAtoms) / 10 ** o.baseDecimals };
}

const NATIVE = 'So11111111111111111111111111111111111111112';
/**
 * Wallet balances of these mints, from the wallet's associated token accounts (under both token
 * programs) and its SOL, in ONE getMultipleAccounts call (1 RPC credit). Tokens held in other,
 * non-associated accounts aren't counted; the app only ever uses associated accounts.
 */
async function walletTokenBalances(walletPk, mints, decimals) {
    const out = {};
    const atas = mints.flatMap(mint => [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(program => ({
        mint, address: getAssociatedTokenAddressSync(new PublicKey(mint), walletPk, true, program),
    })));
    const infos = await connection.getMultipleAccountsInfo([walletPk, ...atas.map(a => a.address)], 'confirmed');
    atas.forEach(({ mint }, i) => {
        const data = infos[i + 1]?.data;
        if (!data || data.length < 72) return;
        out[mint] = (out[mint] || 0) + Number(data.readBigUInt64LE(64)) / 10 ** decimals[mint];
    });
    // Native SOL counts as SOL (wSOL is unwrapped automatically).
    if (mints.includes(NATIVE)) out[NATIVE] = (out[NATIVE] || 0) + (infos[0]?.lamports ?? 0) / 1e9;
    return out;
}

// ---------- orders ----------

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req.body || {}));
    } catch (err) {
        if (err instanceof UserError) log.info('api', 'refused', { path: req.path, wallet: short(req.body?.wallet), code: err.code, msg: err.message });
        else log.error('api', 'failed', { path: req.path, wallet: short(req.body?.wallet), msg: errorDetail(err), stack: err.stack?.split('\n')[1]?.trim() });
        res.status(err.status || 500).json(err instanceof UserError ? { error: err.message, code: err.code } : { error: 'Something went wrong, please try again.' });
    }
};

const writeLimit = rateLimit('write', 30, 60_000);
app.post('/api/orders/prepare', writeLimit, handle(body => orders.prepareOrder(body)));
app.post('/api/orders/cancel', writeLimit, handle(body => orders.prepareCancel(body)));
app.post('/api/orders/withdraw', writeLimit, handle(body => orders.prepareWithdraw(body)));
app.post('/api/markets/create', writeLimit, handle(body => orders.prepareCreateMarket(body)));
const quoteLimit = rateLimit('quote', 40, 60_000);
app.post('/api/swap/quote', quoteLimit, handle(async body => (await orders.quoteSwap(body)).summary));
app.post('/api/swap/prepare', writeLimit, handle(body => orders.prepareSwap(body)));
app.post('/api/payout-accounts/close', writeLimit, handle(body => orders.prepareClosePayout(body)));
app.post('/api/tx/submit', writeLimit, handle(body => orders.submit(body)));
// A token by mint, with its markets against the quotes we offer for new markets.
const NEW_MARKET_QUOTES = [
    { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
];

/**
 * Verified tokens (Jupiter's list) matching a symbol or name, with how many active Manifest
 * markets each has, so the market picker can offer "create a market" for ones with none.
 */
app.get('/api/tokens/search', rateLimit('token-search', 60, 60_000), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ tokens: [] });
    const active = new Map(); // mint -> active market count
    for (const s of markets.allSummaries()) {
        if (s.bidCount + s.askCount === 0) continue;
        for (const m of [s.baseMint, s.quoteMint]) active.set(m, (active.get(m) || 0) + 1);
    }
    const rank = (t) => {
        const sym = (t.symbol || '').toLowerCase(), name = (t.name || '').toLowerCase();
        if (sym === q) return 0;
        if (sym.startsWith(q)) return 1;
        if (name.includes(q)) return 2;
        return null;
    };
    const hits = [];
    for (const t of registry.tokens.values()) {
        if (!t.verified) continue;
        const r = rank(t);
        if (r !== null) hits.push({ t, r });
    }
    hits.sort((a, b) => (a.r - b.r) || ((b.t.liquidity ?? 0) - (a.t.liquidity ?? 0)));
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
        tokens: hits.slice(0, 8).map(({ t }) => ({ ...registry.display(t.mint), activeMarkets: active.get(t.mint) || 0 })),
    });
});
app.get('/api/tokens/:mint', rateLimit('tokens', 30, 60_000), async (req, res) => {
    const mint = req.params.mint;
    try {
        new PublicKey(mint);
    } catch {
        return res.status(400).json({ error: 'Invalid token address' });
    }
    await registry.ensure([mint]);
    // Asked for directly (e.g. a token minted minutes ago): look again even if a lookup failed recently.
    if (!registry.hasDecimals(mint)) await registry.resolve([mint]);
    if (!registry.hasDecimals(mint)) return res.status(404).json({ error: 'Token not found' });
    res.set('Cache-Control', 'no-cache');
    res.json({
        token: registry.display(mint),
        quotes: NEW_MARKET_QUOTES.filter(q => q.mint !== mint).map(q => ({
            ...q,
            market: markets.marketsForPair(mint, q.mint).find(s => s.baseMint === mint)?.address || null,
        })),
    });
});

app.get('/api/payout-accounts', rateLimit('account', 40, 60_000), async (req, res) => {
    try {
        res.set('Cache-Control', 'no-cache');
        res.json(await orders.payoutAccounts(String(req.query.wallet || '')));
    } catch (err) {
        res.status(err.status || 500).json({ error: err instanceof UserError ? err.message : 'Failed to load payout accounts.' });
    }
});


// Production: serve the built frontend (vite dev server proxies /api instead during development).
// ---------- health line (every 15 minutes) ----------
// One line to read when checking on the site: data freshness, load, RPC credit use, the payout
// wallet's SOL, and how many warnings/errors each area logged since the last line.
const HEALTH_MS = 15 * 60 * 1000;
const logHealth = async () => {
    try {
        let viewers = 0, watchers = 0;
        for (const sub of markets.subscriptions.values()) { viewers += sub.viewers; watchers += sub.watchers; }
        const lamports = await connection.getBalance(keeperKeypair.publicKey).catch(() => null);
        const rpc = takeRpcStats();
        log.info('health', 'status', {
            markets: markets.markets.size,
            active: markets.allSummaries().filter(s => s.bidCount + s.askCount > 0).length,
            scanAgeS: Math.round((Date.now() - markets.lastScan) / 1000),
            streams: [...streamsPerIp.values()].reduce((a, b) => a + b, 0),
            viewedMarkets: viewers, payoutWatched: watchers,
            archer: archer.connected ? `up(${archer.subs.size})` : 'down',
            openOrders: orderStore.active().length,
            keeperSol: lamports == null ? '?' : (lamports / 1e9).toFixed(4),
            rpcCalls: rpc.calls, credits15m: rpc.credits, creditsPerDay: Math.round(rpc.credits * 96), topRpc: rpc.top,
            rssMb: Math.round(process.memoryUsage().rss / 1e6),
            problems: takeProblemCounts(),
        });
        if (lamports != null && lamports < 0.05e9) log.error('keeper', 'LOW_BALANCE', { sol: (lamports / 1e9).toFixed(4), feePayer: keeperKeypair.publicKey.toBase58() });
    } catch (err) {
        log.warn('health', 'failed', { msg: err.message });
    }
};
setTimeout(logHealth, 60_000).unref(); // one soon after a restart, then every 15 minutes
setInterval(logHealth, HEALTH_MS).unref();

// ---------- errors from people's browsers ----------
// The order form reports failures that never reach the server (wallet errors, crashes), so
// they show up in these logs too.
app.post('/api/client-log', rateLimit('client-log', 20, 60_000), (req, res) => {
    const b = req.body || {};
    const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
    log.warn('client', clip(b.kind, 40) || 'error', {
        msg: clip(b.message, 300), wallet: short(clip(b.wallet, 44)), market: short(clip(b.market, 44)),
        where: clip(b.where, 80), ua: clip(req.headers['user-agent'], 80),
    });
    res.status(204).end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const DEFAULT_DESCRIPTION = 'Trade Solana tokens on on-chain order books with zero trading fees. Limit orders pay out to your wallet automatically; market orders get the best price across Solana.';
const PAGE_TITLES = { '/account': 'Account', '/terms': 'Terms of Service', '/privacy': 'Privacy Policy' };
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pageMeta(req) {
    const brand = config.brand;
    const m = req.path.match(/^\/trade\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    const s = m && markets.summary(m[1]);
    if (s) {
        const v = marketView(s);
        const price = v.last ? `${formatNumber(v.last)} ${v.quote.symbol}` : null;
        const change = v.change24h != null ? `${v.change24h >= 0 ? '+' : ''}${(v.change24h * 100).toFixed(2)}% 24h` : null;
        return {
            title: `${v.symbol}${price ? ` ${price}` : ''} · ${brand}`,
            description: `Trade ${v.base.name || v.base.symbol} (${v.symbol}) on Solana order books${price ? `: ${[price, change].filter(Boolean).join(', ')}` : ''}. Zero trading fees; limit orders pay out to your wallet automatically.`,
        };
    }
    const page = PAGE_TITLES[req.path];
    return { title: page ? `${page} · ${brand}` : `${brand} · Solana order books`, description: DEFAULT_DESCRIPTION };
}

function formatNumber(n) {
    return n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 4 }) : n.toPrecision(4);
}

function renderIndex(html, req) {
    const { title, description } = pageMeta(req);
    const origin = config.publicUrl || `https://${req.get('host')}`;
    const url = `${origin}${req.path === '/' ? '' : req.path}`;
    const image = `${origin}/og.png`;
    const tags = [
        `<meta name="description" content="${escapeHtml(description)}" />`,
        `<link rel="canonical" href="${escapeHtml(url)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="${escapeHtml(config.brand)}" />`,
        `<meta property="og:title" content="${escapeHtml(title)}" />`,
        `<meta property="og:description" content="${escapeHtml(description)}" />`,
        `<meta property="og:url" content="${escapeHtml(url)}" />`,
        `<meta property="og:image" content="${escapeHtml(image)}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
        `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    ].join('\n    ');
    return html
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace(/<meta name="description"[^>]*>/, tags);
}

const dist = path.join(config.root, 'frontend', 'dist');
if (fs.existsSync(dist)) {
    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    // Link previews (X, Telegram, Discord...) don't run JavaScript, so each page's title,
    // description and preview tags are filled in here; market links show the pair and price.
    app.get(/^\/(?!api\/).*/, (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.type('html').send(renderIndex(indexHtml, req));
    });
}

app.listen(config.port, config.host, () => {
    log.info('server', 'listening', { url: `http://${config.host}:${config.port}`, rpc: config.rpcUrl.replace(/api-key=[^&]+/, 'api-key=…') });
});
