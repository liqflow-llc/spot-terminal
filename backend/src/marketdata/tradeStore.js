// Recent trades and 1-minute candles per market, built from the live fill feed.
// Older chart history is backfilled from GeckoTerminal (which indexes Manifest markets).
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { config } from '../config.js';
import { geckoFetch } from './gecko.js';

const MAX_TRADES = 300;
const KEEP_MINUTES = 3 * 24 * 60;
const SAVE_EVERY_MS = 5 * 60 * 1000;
const FILE = path.join(config.dataDir, 'candles-1m.json');
const GT_API = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const GT_CACHE_MS = 5 * 60 * 1000;
const GECKO_WAIT_MS = 3000;

// TradingView resolution -> [GeckoTerminal timeframe, aggregate, seconds]
const RESOLUTIONS = {
    1: ['minute', 1, 60], 5: ['minute', 5, 300], 15: ['minute', 15, 900],
    60: ['hour', 1, 3600], 240: ['hour', 4, 14400], '1D': ['day', 1, 86400],
};
export const SUPPORTED_RESOLUTIONS = Object.keys(RESOLUTIONS);

export class TradeStore extends EventEmitter {
    /** @param minQuote (market) => smallest trade, in quote tokens, worth recording */
    constructor(markets, minQuote = () => 0) {
        super();
        this.markets = markets; // ManifestMarkets, for decimals
        this.minQuote = minQuote;
        this.trades = new Map();  // market -> newest-first trades
        this.candles = new Map(); // market -> Map(minuteStartSec -> [o, h, l, c, vBase])
        this.gtCache = new Map();
        this.load();
        setInterval(() => this.save(), SAVE_EVERY_MS).unref();
    }

    /** A trade inferred from market snapshots: { price, size, quote, side } (taker side). */
    addTrade(market, { price, size, quote, side }, time = Date.now()) {
        if (!this.markets.summary(market) || !(price > 0) || !(size > 0)) return;
        // Dust fills (fractions of a cent hitting stale orders far from the market) would put
        // absurd wicks on the chart and the 24h high/low.
        if (quote < this.minQuote(market)) return;
        const fill = { market, time };
        const trade = { time, price, size, side };

        let list = this.trades.get(fill.market);
        if (!list) this.trades.set(fill.market, (list = []));
        list.unshift(trade);
        if (list.length > MAX_TRADES) list.length = MAX_TRADES;

        const minute = Math.floor(fill.time / 60000) * 60;
        let series = this.candles.get(fill.market);
        if (!series) this.candles.set(fill.market, (series = new Map()));
        const c = series.get(minute);
        if (c) {
            c[1] = Math.max(c[1], price);
            c[2] = Math.min(c[2], price);
            c[3] = price;
            c[4] += size;
        } else {
            series.set(minute, [price, price, price, price, size]);
        }
        this.emit('trade', fill.market, trade);
    }

    recentTrades(market, limit = 50) {
        return (this.trades.get(market) || []).slice(0, limit);
    }

    /** Last trade price and 24h stats from our own data (null fields when we have none). */
    stats(market) {
        const series = this.candles.get(market);
        const last = this.trades.get(market)?.[0]?.price ?? null;
        if (!series) return { last, open24h: null, high24h: null, low24h: null, volume24hBase: null, coverageHours: 0 };
        const since = Date.now() / 1000 - 86400;
        let open = null, high = -Infinity, low = Infinity, vol = 0, firstTs = Infinity;
        for (const [ts, [o, h, l, , v]] of series) {
            if (ts < since) continue;
            if (ts < firstTs) { firstTs = ts; open = o; }
            high = Math.max(high, h);
            low = Math.min(low, l);
            vol += v;
        }
        return {
            last,
            // How much of the last 24h our own candles cover.
            coverageHours: firstTs === Infinity ? 0 : (Date.now() / 1000 - firstTs) / 3600,
            open24h: open,
            high24h: high === -Infinity ? null : high,
            low24h: low === Infinity ? null : low,
            volume24hBase: vol,
        };
    }

    // ---------- candles for the chart ----------

    /** Bars ({ time: ms, open, high, low, close, volume }) for [from, to) seconds, oldest first. */
    async bars(market, resolution, from, to) {
        const spec = RESOLUTIONS[resolution];
        if (!spec) throw new Error(`Unsupported resolution ${resolution}`);
        const [, , seconds] = spec;
        const own = this.ownBars(market, seconds, from, to);
        const ownStart = own.length ? own[0].time / 1000 : Infinity;
        // Use GeckoTerminal only for the period before our own data begins.
        let history = [];
        if (from < ownStart) {
            // GeckoTerminal is queued and rate limited (a 429 pauses it for a minute), so don't hold
            // the chart hostage: answer with our own bars if it's slow. The fetch carries on and is
            // cached, so the next load of this chart gets the history.
            const fetching = this.geckoBars(market, resolution, Math.min(to, ownStart));
            fetching.catch(err => console.error(`GeckoTerminal OHLCV failed for ${market}:`, err.message));
            const bars = await Promise.race([fetching.catch(() => []), new Promise(r => setTimeout(r, GECKO_WAIT_MS, null))]);
            if (bars) history = bars.filter(b => b.time / 1000 >= from && b.time / 1000 < Math.min(to, ownStart));
        }
        return [...history, ...own];
    }

    ownBars(market, seconds, from, to) {
        const series = this.candles.get(market);
        if (!series) return [];
        const buckets = new Map();
        for (const [ts, [o, h, l, c, v]] of [...series].sort((a, b) => a[0] - b[0])) {
            if (ts < from || ts >= to) continue;
            const b = Math.floor(ts / seconds) * seconds;
            const bar = buckets.get(b);
            if (bar) {
                bar.high = Math.max(bar.high, h);
                bar.low = Math.min(bar.low, l);
                bar.close = c;
                bar.volume += v;
            } else {
                buckets.set(b, { time: b * 1000, open: o, high: h, low: l, close: c, volume: v });
            }
        }
        return [...buckets.values()];
    }

    async geckoBars(market, resolution, before) {
        const [timeframe, aggregate] = RESOLUTIONS[resolution];
        const s = this.markets.summary(market);
        if (!s) return [];
        // Cache by market+resolution and a coarse "before" bucket so scrolling back reuses pages.
        const bucket = Math.floor(before / 3600);
        const key = `${market}|${resolution}|${bucket}`;
        const hit = this.gtCache.get(key);
        if (hit && Date.now() - hit.at < GT_CACHE_MS) return hit.bars;

        const url = `${GT_API}/${market}/ohlcv/${timeframe}?aggregate=${aggregate}&before_timestamp=${Math.floor(before)}&limit=1000&currency=token&token=${s.baseMint}`;
        const json = await geckoFetch(url);
        const bars = (json?.data?.attributes?.ohlcv_list || [])
            .map(([t, o, h, l, c, v]) => ({ time: t * 1000, open: +o, high: +h, low: +l, close: +c, volume: +v }))
            .sort((a, b) => a.time - b.time);
        this.gtCache.set(key, { at: Date.now(), bars });
        return bars;
    }

    // ---------- persistence ----------

    load() {
        try {
            const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            let dropped = 0;
            for (const [market, rows] of Object.entries(saved)) {
                const clean = sanitizeCandles(rows);
                dropped += rows.length - clean.length;
                this.candles.set(market, new Map(clean));
            }
            if (dropped) console.log(`TradeStore: dropped ${dropped} outlier candles`);
            console.log(`TradeStore: loaded 1m candles for ${this.candles.size} markets`);
        } catch {
            // First run.
        }
    }

    save() {
        const cutoff = Date.now() / 1000 - KEEP_MINUTES * 60;
        const out = {};
        for (const [market, series] of this.candles) {
            for (const ts of series.keys()) if (ts < cutoff) series.delete(ts);
            if (series.size) out[market] = [...series];
            else this.candles.delete(market);
        }
        try {
            fs.mkdirSync(config.dataDir, { recursive: true });
            fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(out));
            fs.renameSync(`${FILE}.tmp`, FILE);
        } catch (err) {
            console.error('TradeStore: save failed:', err.message);
        }
    }
}

/**
 * Drop 1m candles wildly off the market's typical price (e.g. a mis-inferred trade against a
 * dust order). Real moves of 20x within the 3 days we keep are not something to chart from
 * single minutes anyway.
 */
const OUTLIER_FACTOR = 20;
function sanitizeCandles(rows) {
    const closes = rows.map(([, c]) => c[3]).filter(v => v > 0).sort((a, b) => a - b);
    if (closes.length < 5) return rows;
    const median = closes[Math.floor(closes.length / 2)];
    return rows.filter(([, [, high, low]]) => low >= median / OUTLIER_FACTOR && high <= median * OUTLIER_FACTOR);
}
