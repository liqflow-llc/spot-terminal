// 24h volume / price change per Manifest market from GeckoTerminal, used until our own data
// covers a full day (after a fresh start our counters only know the last hour or so).
const GT_MULTI = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/multi';
const BATCH = 30;
const REFRESH_MS = 10 * 60 * 1000;
const GAP_MS = 2500; // free tier: 30 requests/minute
const TOP_MARKETS = 300;

export class GeckoStats {
    constructor(markets) {
        this.markets = markets;
        this.stats = new Map(); // market -> { volume24hUsd, change24h, at }
    }

    start() {
        const run = () => this.refresh().catch(err => console.error('GeckoTerminal stats failed:', err.message));
        run();
        setInterval(run, REFRESH_MS).unref();
    }

    async refresh() {
        // Markets with the most resting orders are the ones people will look at.
        const addresses = this.markets.allSummaries()
            .filter(s => s.bidCount + s.askCount > 0)
            .sort((a, b) => (b.bidCount + b.askCount) - (a.bidCount + a.askCount))
            .slice(0, TOP_MARKETS)
            .map(s => s.address);
        for (let i = 0; i < addresses.length; i += BATCH) {
            const chunk = addresses.slice(i, i + BATCH);
            const res = await fetch(`${GT_MULTI}/${chunk.join(',')}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
            if (res.ok) {
                const json = await res.json();
                const now = Date.now();
                for (const pool of json.data || []) {
                    const a = pool.attributes || {};
                    const address = a.address || pool.id?.split('_').pop();
                    const vol = Number(a.volume_usd?.h24);
                    const change = Number(a.price_change_percentage?.h24);
                    this.stats.set(address, {
                        volume24hUsd: Number.isFinite(vol) ? vol : null,
                        change24h: Number.isFinite(change) ? change / 100 : null,
                        at: now,
                    });
                }
            }
            await new Promise(r => setTimeout(r, GAP_MS));
        }
    }

    get(address) {
        return this.stats.get(address) || null;
    }
}
