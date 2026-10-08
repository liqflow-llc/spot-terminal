// The "all Solana" chart: candles from the most active pool trading the pair anywhere on Solana
// (Orca, Raydium, Meteora, ...), via GeckoTerminal. The Manifest chart shows SpotTerminal's own book,
// which is what limit orders fill against; this one shows where the market as a whole traded.
//
// Pool choice: the pair's own pool with the most 24h volume (not liquidity: some pools report
// large reserves and barely trade). No pool for the pair: the base token's most active pool,
// priced in USD, divided by the quote token's USD price at each candle ("via USD"). No active
// pool at all (a thin token, e.g. one with no Manifest market yet): the pair's deepest quiet pool.
import { geckoFetch } from './gecko.js';
import { RESOLUTIONS } from './tradeStore.js';
import { log } from '../log.js';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
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
    }

    /** Pools trading `mint`, most active first (excluding Manifest, which is the other chart), quiet ones included. */
    async poolsFor(mint) {
        const hit = this.pools.get(mint);
        if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.pools;
        const json = await geckoFetch(`${GT}/tokens/${mint}/pools?page=1&sort=h24_volume_usd_liquidity_desc&include=dex`);
        const pools = (json?.data || [])
            .map(p => ({
                address: p.attributes.address,
                name: p.attributes.name,
                dex: p.relationships?.dex?.data?.id || '',
                base: mintOf(p.relationships?.base_token),
                quote: mintOf(p.relationships?.quote_token),
                volume: Number(p.attributes.volume_usd?.h24) || 0,
                liquidity: Number(p.attributes.reserve_in_usd) || 0,
            }))
            .filter(p => !/manifest/i.test(p.dex))
            .sort((a, b) => b.volume - a.volume);
        this.pools.set(mint, { at: Date.now(), pools });
        return pools;
    }

    /** Where this market's all-Solana candles come from, or null if no active pool exists. */
    async source(market) {
        const hit = this.sources.get(market);
        if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.source;
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
        const json = await geckoFetch(url);
        const bars = (json?.data?.attributes?.ohlcv_list || [])
            .map(([t, o, h, l, c, v]) => ({ time: t * 1000, open: +o, high: +h, low: +l, close: +c, volume: +v }))
            .sort((a, b) => a.time - b.time);
        this.cache.set(url, { at: Date.now(), bars });
        if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
        return bars;
    }

    /** Candles priced in the market's quote token, oldest first, for TradingView. */
    async bars(market, resolution, from, to, countBack = 0) {
        const s = await this.summary(market);
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
        const upTo = bars.filter(b => b.time < to * 1000); // `to` is exclusive: the next page starts there
        const inRange = upTo.filter(b => b.time >= from * 1000);
        // TradingView's countBack: the bars it wants ending at `to`, even from before `from`. A
        // quiet pool (weeks between trades) then shows its last candles instead of "no data".
        return { bars: countBack > inRange.length ? upTo.slice(-countBack) : inRange, source };
    }
}
