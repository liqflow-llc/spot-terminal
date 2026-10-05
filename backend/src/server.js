import fs from 'fs';
import path from 'path';
import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { connection } from './solana.js';
import { TokenRegistry } from './tokens/tokenRegistry.js';
import { ManifestMarkets } from './venues/manifest/markets.js';
import { ManifestFillFeed } from './venues/manifest/fills.js';
import { TradeStore, SUPPORTED_RESOLUTIONS } from './marketdata/tradeStore.js';
import { OrderStore } from './orders/orderStore.js';
import { OrderService, UserError } from './orders/orderService.js';
import { Keeper, loadKeeperKeypair } from './orders/keeper.js';
import { aggregateBook } from './marketdata/aggregate.js';
import { GeckoStats } from './marketdata/geckoStats.js';

const registry = new TokenRegistry({ heliusRpc: config.rpcUrl, jupApiKey: config.jupApiKey });
registry.startBackgroundRefresh();

const markets = new ManifestMarkets();
const MIN_TRADE_USD = 0.5;
const trades = new TradeStore(markets, (market) => {
    const quoteUsd = registry.cachedPrice(markets.summary(market)?.quoteMint);
    return quoteUsd ? MIN_TRADE_USD / quoteUsd : 0;
});
const fills = new ManifestFillFeed();
const orderStore = new OrderStore();
const keeperKeypair = loadKeeperKeypair();
const orders = new OrderService({ markets, store: orderStore, keeperPubkey: keeperKeypair.publicKey });
const keeper = new Keeper({ markets, store: orderStore, keypair: keeperKeypair });
orders.onPlaced = (id) => keeper.track(id);

fills.on('fill', (fill) => {
    trades.addFill(fill);
    keeper.onFill(fill);
});

await markets.startScanning();
// Token metadata for everything listed on Manifest (cached on disk after the first run).
registry.ensure([...new Set(markets.allSummaries().flatMap(s => [s.baseMint, s.quoteMint]))])
    .catch(err => console.error('Token metadata resolve failed:', err.message));
fills.start();
keeper.start();
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
function bookFor(s, depth) {
    const quoteUsd = registry.cachedPrice(s.quoteMint);
    return aggregateBook(markets, s, depth, quoteUsd ? 0.01 / quoteUsd : 0);
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
    let list = markets.allSummaries().filter(s => s.bidCount + s.askCount > 0).map(marketView);
    if (q) list = list.filter(m => m.symbol.toLowerCase().includes(q) || m.base.mint === req.query.q || m.address === req.query.q);
    // Exact token matches first (so "JUP" finds JUP before JupSOL), then verified pairs with
    // real 24h activity.
    const exact = (m) => Number(!!q && (m.base.symbol.toLowerCase() === q || m.base.mint === req.query.q));
    list.sort((a, b) =>
        (exact(b) - exact(a)) ||
        (Number(b.base.verified && b.quote.verified) - Number(a.base.verified && a.quote.verified)) ||
        ((b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)) || (b.orders - a.orders));
    res.set('Cache-Control', 'public, max-age=5');
    res.json({ markets: list.slice(0, limit) });
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
    let bookTimer = null;
    const pushBook = () => {
        bookTimer = null;
        send('book', bookFor(markets.summary(address), 60));
    };
    const onUpdate = (a) => {
        if ((a === address || pairMarkets.includes(a)) && !bookTimer) bookTimer = setTimeout(pushBook, 200);
    };
    const onTrade = (m, trade) => {
        if (m === address) send('trade', trade);
    };
    markets.on('update', onUpdate);
    trades.on('trade', onTrade);
    pushBook();
    const ticker = setInterval(() => send('ticker', marketView(markets.summary(address), { withHiLo: true })), 5000);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
        const left = (streamsPerIp.get(ip) || 1) - 1;
        if (left > 0) streamsPerIp.set(ip, left); else streamsPerIp.delete(ip);
        markets.off('update', onUpdate);
        trades.off('trade', onTrade);
        clearTimeout(bookTimer);
        clearInterval(ticker);
        clearInterval(ping);
        release();
        releasePair.forEach(r => r());
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
        const [walletBalances] = await Promise.all([walletTokenBalances(walletPk, [s.baseMint, s.quoteMint])]);
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
async function walletTokenBalances(walletPk, mints) {
    const out = {};
    const [lamports, ...programs] = await Promise.all([
        connection.getBalance(walletPk, 'confirmed'),
        connection.getParsedTokenAccountsByOwner(walletPk, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }, 'confirmed'),
        connection.getParsedTokenAccountsByOwner(walletPk, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }, 'confirmed'),
    ]);
    for (const { value } of programs) {
        for (const a of value) {
            const info = a.account.data.parsed.info;
            if (mints.includes(info.mint)) out[info.mint] = (out[info.mint] || 0) + Number(info.tokenAmount.uiAmount || 0);
        }
    }
    // Native SOL counts as SOL (wSOL is unwrapped automatically).
    if (mints.includes(NATIVE)) out[NATIVE] = (out[NATIVE] || 0) + lamports / 1e9;
    return out;
}

// ---------- orders ----------

const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req.body || {}));
    } catch (err) {
        if (!(err instanceof UserError)) console.error(`${req.path} failed:`, err);
        res.status(err.status || 500).json({ error: err instanceof UserError ? err.message : 'Something went wrong, please try again.' });
    }
};

const writeLimit = rateLimit('write', 30, 60_000);
app.post('/api/orders/prepare', writeLimit, handle(body => orders.prepareOrder(body)));
app.post('/api/orders/cancel', writeLimit, handle(body => orders.prepareCancel(body)));
app.post('/api/orders/withdraw', writeLimit, handle(body => orders.prepareWithdraw(body)));
app.post('/api/payout-accounts/close', writeLimit, handle(body => orders.prepareClosePayout(body)));
app.post('/api/tx/submit', writeLimit, handle(body => orders.submit(body)));
app.get('/api/payout-accounts', rateLimit('account', 40, 60_000), async (req, res) => {
    try {
        res.set('Cache-Control', 'no-cache');
        res.json(await orders.payoutAccounts(String(req.query.wallet || '')));
    } catch (err) {
        res.status(err.status || 500).json({ error: err instanceof UserError ? err.message : 'Failed to load payout accounts.' });
    }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Production: serve the built frontend (vite dev server proxies /api instead during development).
const dist = path.join(config.root, 'frontend', 'dist');
if (fs.existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(config.port, config.host, () => {
    console.log(`API listening on http://${config.host}:${config.port}`);
});
