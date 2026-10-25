// The "all Solana" chart: where the pair traded across every Solana DEX (Orca, Raydium, Meteora,
// ...). The Manifest chart shows SpotTerminal's own book, which is what limit orders fill against.
//
// Candles come from Jupiter's chart data (the API behind jup.ag's charts: its price across every
// venue, in any quote token, ~0.3s, no rate limit seen at 40 parallel calls). It isn't a documented
// API, so if it fails or has no candles the chart falls back to GeckoTerminal, below.
//
// GeckoTerminal fallback, pool choice: the pair's own pool with the most 24h volume (not liquidity: some pools report
// large reserves and barely trade). No pool for the pair: the base token's most active pool,
// priced in USD, divided by the quote token's USD price at each candle ("via USD"). No active
// pool at all (a thin token, e.g. one with no Manifest market yet): the pair's deepest quiet pool.
//
// GeckoTerminal's free API allows only a few calls a minute (gecko.js queues them), so the pool
// list comes from DexScreener (300/minute) and only the candles from GeckoTerminal.
import { geckoFetch } from './gecko.js';
import { RESOLUTIONS } from './tradeStore.js';
import { log } from '../log.js';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const JUP_CHARTS = 'https://datapi.jup.ag/v2/charts';
const JUP_INTERVALS = { 1: '1_MINUTE', 5: '5_MINUTE', 15: '15_MINUTE', 60: '1_HOUR', 240: '4_HOUR', '1D': '1_DAY' };
const JUP_MAX_CANDLES = 2000;
const JUP_DOWN_MS = 5 * 60 * 1000; // after a failure, use GeckoTerminal for a while
const DEXSCREENER = 'https://api.dexscreener.com/token-pairs/v1/solana';
// DexScreener names a pool type with a label ("meteora" + "DLMM"); GeckoTerminal's ids, which
// the frontend names, fold it in ("meteora-dlmm").
const DS_KINDS = { DLMM: '-dlmm', CLMM: '-clmm', CPMM: '-cp' };
const SOURCE_TTL_MS = 60 * 60 * 1000;
const RECENT_TTL_MS = 2 * 60 * 1000;   // the newest page (live ticks come from the reference price)
const OLD_TTL_MS = 60 * 60 * 1000;     // older pages don't change
const MIN_VOLUME_USD = 1000;
const STABLES = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const active = (p) => p.volume >= MIN_VOLUME_USD;
const mintOf = (rel) => String(rel?.data?.id || '').replace(/^solana_/, '');

export class AmmChart {
    /** @param summary async (market) => { baseMint, quoteMint } | null (a Manifest market or a no-market pair) */
    constructor({ summary }) {
        this.summary = summary;
        this.sources = new Map(); // market -> { at, source }
        this.pools = new Map();   // token mint -> { at, pools }
        this.cache = new Map();   // url -> { at, bars }
        this.inflight = new Map(); // key -> promise, so a chart's parallel requests share one lookup
    }

    /** Runs `fn` once for concurrent callers asking for the same `key`. */
    once(key, fn) {
        let p = this.inflight.get(key);
        if (!p) {
            p = fn().finally(() => this.inflight.delete(key));
            this.inflight.set(key, p);
        }
        return p;
    }

    /** Pools trading `mint`, most active first (excluding Manifest, which is the other chart), quiet ones included. */
    async poolsFor(mint) {
        const hit = this.pools.get(mint);
        if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.pools;
        return this.once(`pools|${mint}`, async () => {
            let pools;
            try {
                pools = await this.dexscreenerPools(mint);
            } catch (err) {
                log.warn('amm-chart', 'dexscreener_failed', { mint: mint.slice(0, 6), msg: err.message });
                pools = await this.geckoPools(mint);
            }
            pools = pools.filter(p => !/manifest/i.test(p.dex)).sort((a, b) => b.volume - a.volume);
            this.pools.set(mint, { at: Date.now(), pools });
            return pools;
        });
    }

    async dexscreenerPools(mint) {
        const res = await fetch(`${DEXSCREENER}/${mint}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('DexScreener: unexpected response');
        return list.map(p => ({
            address: p.pairAddress,
            name: `${p.baseToken?.symbol} / ${p.quoteToken?.symbol}`,
            dex: `${p.dexId || ''}${(p.labels || []).map(l => DS_KINDS[l] || '').join('')}`,
            base: p.baseToken?.address || '',
            quote: p.quoteToken?.address || '',
            volume: Number(p.volume?.h24) || 0,
            liquidity: Number(p.liquidity?.usd) || 0,
        }));
    }

    async geckoPools(mint) {
        const json = await geckoFetch(`${GT}/tokens/${mint}/pools?page=1&sort=h24_volume_usd_liquidity_desc&include=dex`);
        return (json?.data || [])
            .map(p => ({
                address: p.attributes.address,
                name: p.attributes.name,
                dex: p.relationships?.dex?.data?.id || '',
                base: mintOf(p.relationships?.base_token),
                quote: mintOf(p.relationships?.quote_token),
                volume: Number(p.attributes.volume_usd?.h24) || 0,
                liquidity: Number(p.attributes.reserve_in_usd) || 0,
            }));
    }

    /** Where this market's all-Solana candles come from, or null if no active pool exists. */
    async source(market) {
        const hit = this.sources.get(market);
        if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.source;
        return this.once(`source|${market}`, () => this.findSource(market));
    }

    async findSource(market) {
        const s = await this.summary(market);
        if (!s) return null;
        let source = null;
        const allBasePools = await this.poolsFor(s.baseMint);
        const basePools = allBasePools.filter(active);
        const isPair = (p) => (p.base === s.baseMint && p.quote === s.quoteMint) || (p.base === s.quoteMint && p.quote === s.baseMint);
        const pair = basePools.find(isPair);
        if (pair) {
            source = { via: 'pair', pool: pair.address, dex: pair.dex, name: pair.name };
        } else if (basePools[0]) {
            const quotePool = STABLES.has(s.quoteMint) ? null : (await this.poolsFor(s.quoteMint)).filter(active)[0];
            if (STABLES.has(s.quoteMint) || quotePool) {
                source = { via: 'usd', pool: basePools[0].address, dex: basePools[0].dex, name: basePools[0].name, quotePool: quotePool?.address || null };
            }
        }
        if (!source) {
            // Better a quiet chart than none: the pair's deepest pool whatever its volume, else the
            // base token's deepest pool priced via USD.
            const deepest = (list) => list.filter(p => p.liquidity > 0).sort((a, b) => b.liquidity - a.liquidity)[0];
            const quietPair = deepest(allBasePools.filter(isPair));
            const quietBase = !quietPair && deepest(allBasePools);
            if (quietPair) source = { via: 'pair', pool: quietPair.address, dex: quietPair.dex, name: quietPair.name, quiet: true };
            else if (quietBase) {
                const quotePool = STABLES.has(s.quoteMint) ? null : (await this.poolsFor(s.quoteMint)).filter(active)[0];
                if (STABLES.has(s.quoteMint) || quotePool) {
                    source = { via: 'usd', pool: quietBase.address, dex: quietBase.dex, name: quietBase.name, quotePool: quotePool?.address || null, quiet: true };
                }
            }
        }
        this.sources.set(market, { at: Date.now(), source });
        log.info('amm-chart', 'source', { market: market.slice(0, 6), via: source?.via || 'none', dex: source?.dex, pool: source?.pool?.slice(0, 6) });
        return source;
    }

    async ohlcv(pool, token, currency, resolution, before) {
        const [timeframe, aggregate] = RESOLUTIONS[resolution] || [];
        if (!timeframe) throw new Error('Unsupported resolution');
        const url = `${GT}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&before_timestamp=${Math.floor(before)}&limit=1000&currency=${currency}&token=${token}`;
        const hit = this.cache.get(url);
        const recent = Date.now() / 1000 - before < 3600;
        if (hit && Date.now() - hit.at < (recent ? RECENT_TTL_MS : OLD_TTL_MS)) return hit.bars;
        return this.once(url, async () => {
            const json = await geckoFetch(url);
            const bars = (json?.data?.attributes?.ohlcv_list || [])
                .map(([t, o, h, l, c, v]) => ({ time: t * 1000, open: +o, high: +h, low: +l, close: +c, volume: +v }))
                .sort((a, b) => a.time - b.time);
            this.cache.set(url, { at: Date.now(), bars });
            if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
            return bars;
        });
    }

    /** Jupiter is the source unless it failed recently; then GeckoTerminal's pool. */
    async chartSource(market) {
        if (!(this.jupiterDownUntil > Date.now())) return { via: 'jupiter' };
        return this.source(market);
    }

    /** The pair's candles from Jupiter, oldest first, or null if it has none. */
    async jupiterBars(s, resolution, from, to, countBack) {
        const interval = JUP_INTERVALS[resolution];
        const [, , seconds] = RESOLUTIONS[resolution] || [];
        if (!interval || !seconds) return null;
        // End on a candle boundary so recent requests share one cached URL.
        const end = Math.ceil(Math.min(to, Date.now() / 1000 + 60) / seconds) * seconds;
        const candles = Math.min(JUP_MAX_CANDLES, Math.max(countBack, Math.ceil((end - from) / seconds) + 1));
        const url = `${JUP_CHARTS}/${s.baseMint}?interval=${interval}&to=${end * 1000}&candles=${candles}&type=price&quote=${s.quoteMint}`;
        const hit = this.cache.get(url);
        const recent = Date.now() / 1000 - end < 3600;
        if (hit && Date.now() - hit.at < (recent ? 60_000 : OLD_TTL_MS)) return hit.bars;
        return this.once(url, async () => {
            const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`Jupiter charts HTTP ${res.status}`);
            const json = await res.json();
            if (!Array.isArray(json?.candles)) throw new Error('Jupiter charts: unexpected response');
            const bars = json.candles
                .filter(c => c.close > 0)
                .map(c => ({ time: c.time * 1000, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume || 0 }))
                .sort((a, b) => a.time - b.time);
            this.cache.set(url, { at: Date.now(), bars });
            if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
            return bars;
        });
    }

    /** Candles priced in the market's quote token, oldest first, for TradingView. */
    async bars(market, resolution, from, to, countBack = 0) {
        const s = await this.summary(market);
        if (s && !(this.jupiterDownUntil > Date.now())) {
            try {
                const bars = await this.jupiterBars(s, resolution, from, to, countBack);
                if (bars?.length) return { bars: this.window(bars, from, to, countBack), source: { via: 'jupiter' } };
            } catch (err) {
                this.jupiterDownUntil = Date.now() + JUP_DOWN_MS;
                log.warn('amm-chart', 'jupiter_failed', { market: market.slice(0, 6), msg: err.message, note: 'GeckoTerminal for 5 minutes' });
            }
        }
        const source = await this.source(market);
        if (!s || !source) return { bars: [], source };
        // Gecko pages back from `before`; one page (up to 1000 candles) per request.
        const before = Math.min(to, Math.floor(Date.now() / 1000) + 60);
        let bars;
        if (source.via === 'pair') {
            bars = await this.ohlcv(source.pool, s.baseMint, 'token', resolution, before);
        } else {
            const base = await this.ohlcv(source.pool, s.baseMint, 'usd', resolution, before);
            if (!source.quotePool) bars = base; // quoted in a USD stablecoin: USD is close enough
            else {
                const quote = new Map((await this.ohlcv(source.quotePool, s.quoteMint, 'usd', resolution, before)).map(b => [b.time, b.close]));
                bars = base.filter(b => quote.get(b.time) > 0).map((b) => {
                    const q = quote.get(b.time);
                    return { time: b.time, open: b.open / q, high: b.high / q, low: b.low / q, close: b.close / q, volume: b.volume };
                });
            }
        }
        return { bars: this.window(bars, from, to, countBack), source };
    }

    window(bars, from, to, countBack) {
        const upTo = bars.filter(b => b.time < to * 1000); // `to` is exclusive: the next page starts there
        const inRange = upTo.filter(b => b.time >= from * 1000);
        // TradingView's countBack: the bars it wants ending at `to`, even from before `from`. A
        // quiet pool (weeks between trades) then shows its last candles instead of "no data".
        return countBack > inRange.length ? upTo.slice(-countBack) : inRange;
    }
}
