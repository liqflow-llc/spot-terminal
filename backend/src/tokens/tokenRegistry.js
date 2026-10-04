// Token metadata (symbol, name, decimals, icon) and USD prices.
//
// Sources, in order of trust:
//   1. Jupiter's verified token list (one call, ~4k tokens, includes USD price + liquidity)
//   2. Helius DAS getAssetBatch (1000 mints per call) for the long tail
//   3. On-chain mint account (getMultipleAccounts) when DAS has no decimals
// Resolved metadata is persisted to disk so restarts don't re-fetch ~40k mints.
// Failed lookups are retried later instead of being cached forever.
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const JUP_API = 'https://api.jup.ag';
const CACHE_FILE = path.join(config.dataDir, 'token-cache.json');
const VERIFIED_REFRESH_MS = 10 * 60 * 1000;
const PRICE_TTL_MS = 60 * 1000;
const RETRY_UNRESOLVED_MS = 6 * 60 * 60 * 1000;
const DAS_BATCH = 1000;
const MINT_ACCOUNT_BATCH = 100;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Never depend on a network call for the tokens nearly every pair is quoted in.
const BUILTIN = {
    [SOL_MINT]: { symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, verified: true, icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
    [USDC_MINT]: { symbol: 'USDC', name: 'USD Coin', decimals: 6, verified: true, icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
    [USDT_MINT]: { symbol: 'USDT', name: 'USDT', decimals: 6, verified: true, icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg' },
};

function cleanText(value, maxLen) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

function shortMint(mint) {
    return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export class TokenRegistry {
    constructor({ heliusRpc, jupApiKey }) {
        this.heliusRpc = heliusRpc;
        this.jupHeaders = jupApiKey ? { 'x-api-key': jupApiKey } : {};
        // Jupiter's keyless tier is 0.5 req/s, a free key gets 1 req/s.
        this.jupMinGapMs = jupApiKey ? 1100 : 2100;
        this.jupQueue = Promise.resolve();
        this.jupLastCall = 0;

        this.tokens = new Map();      // mint -> metadata
        this.unresolved = new Map();  // mint -> timestamp of last failed lookup
        this.prices = new Map();      // mint -> { usd, at }
        this.priceInflight = new Set();
        this.inflight = new Map();    // mint -> Promise (dedupes concurrent lookups)
        this.saveTimer = null;

        for (const [mint, meta] of Object.entries(BUILTIN)) {
            this.tokens.set(mint, { mint, ...meta, source: 'builtin' });
        }
        this.loadFromDisk();
    }

    // ---------- persistence ----------

    loadFromDisk() {
        try {
            if (!fs.existsSync(CACHE_FILE)) return;
            const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            for (const t of saved.tokens || []) {
                if (!BUILTIN[t.mint]) this.tokens.set(t.mint, t);
            }
            console.log(`TokenRegistry: loaded ${this.tokens.size} tokens from disk`);
        } catch (err) {
            console.error('TokenRegistry: failed to load cache file:', err.message);
        }
    }

    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            try {
                fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
                const tmp = `${CACHE_FILE}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), tokens: [...this.tokens.values()] }));
                fs.renameSync(tmp, CACHE_FILE);
            } catch (err) {
                console.error('TokenRegistry: failed to save cache file:', err.message);
            }
        }, 5000);
    }

    // ---------- lookups ----------

    get(mint) {
        return this.tokens.get(mint) || null;
    }

    /** Display info that is always safe to use, even before metadata has resolved. */
    display(mint) {
        const t = this.tokens.get(mint);
        const price = this.cachedPrice(mint);
        return {
            mint,
            symbol: t?.symbol || shortMint(mint),
            name: t?.name || '',
            decimals: t ? t.decimals : null,
            icon: t?.icon || null,
            verified: !!t?.verified,
            usdPrice: price,
        };
    }

    hasDecimals(mint) {
        const t = this.tokens.get(mint);
        return !!t && Number.isInteger(t.decimals);
    }

    /** Make sure metadata for these mints is loaded. Resolves once lookups finish (or fail). */
    async ensure(mints) {
        const now = Date.now();
        const missing = [];
        const waits = [];
        for (const mint of new Set(mints)) {
            if (this.hasDecimals(mint)) continue;
            if (this.inflight.has(mint)) { waits.push(this.inflight.get(mint)); continue; }
            const failedAt = this.unresolved.get(mint);
            if (failedAt && now - failedAt < RETRY_UNRESOLVED_MS) continue;
            missing.push(mint);
        }
        if (missing.length) {
            const job = this.resolve(missing).finally(() => missing.forEach(m => this.inflight.delete(m)));
            missing.forEach(m => this.inflight.set(m, job));
            waits.push(job);
        }
        await Promise.all(waits);
    }

    async resolve(mints) {
        for (let i = 0; i < mints.length; i += DAS_BATCH) {
            const chunk = mints.slice(i, i + DAS_BATCH);
            try {
                await this.fetchFromDas(chunk);
            } catch (err) {
                console.error(`TokenRegistry: DAS batch failed (${chunk.length} mints):`, err.message);
            }
            const noDecimals = chunk.filter(m => !this.hasDecimals(m));
            for (let j = 0; j < noDecimals.length; j += MINT_ACCOUNT_BATCH) {
                const sub = noDecimals.slice(j, j + MINT_ACCOUNT_BATCH);
                try {
                    await this.fetchMintAccounts(sub);
                } catch (err) {
                    console.error('TokenRegistry: mint account lookup failed:', err.message);
                }
            }
            const now = Date.now();
            for (const m of chunk) {
                if (!this.hasDecimals(m)) this.unresolved.set(m, now);
                else this.unresolved.delete(m);
            }
        }
        this.scheduleSave();
    }

    async heliusRpcCall(method, params) {
        const res = await fetch(this.heliusRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(30000),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        return json.result;
    }

    async fetchFromDas(mints) {
        const assets = await this.heliusRpcCall('getAssetBatch', { ids: mints, options: { showFungible: true } });
        for (const a of assets || []) {
            if (!a || !a.id || BUILTIN[a.id]) continue;
            const existing = this.tokens.get(a.id);
            if (existing?.verified) continue; // Jupiter's verified data wins
            const decimals = a.token_info?.decimals;
            if (!Number.isInteger(decimals)) continue;
            const symbol = cleanText(a.content?.metadata?.symbol || a.token_info?.symbol, 24);
            const name = cleanText(a.content?.metadata?.name, 64);
            const icon = a.content?.files?.[0]?.cdn_uri || a.content?.links?.image || null;
            const usd = a.token_info?.price_info?.price_per_token;
            this.tokens.set(a.id, {
                mint: a.id,
                symbol: symbol || null,
                name: name || null,
                decimals,
                icon: typeof icon === 'string' && /^https:\/\//.test(icon) ? icon : null,
                verified: false,
                source: 'das',
            });
            if (typeof usd === 'number' && usd > 0) this.setPrice(a.id, usd, Date.now() - PRICE_TTL_MS / 2);
        }
    }

    async fetchMintAccounts(mints) {
        const result = await this.heliusRpcCall('getMultipleAccounts', [mints, { encoding: 'jsonParsed' }]);
        result.value.forEach((acc, i) => {
            const decimals = acc?.data?.parsed?.info?.decimals;
            if (!Number.isInteger(decimals)) return;
            const mint = mints[i];
            const existing = this.tokens.get(mint);
            this.tokens.set(mint, { mint, symbol: null, name: null, icon: null, verified: false, ...existing, decimals, source: existing?.source || 'mint-account' });
        });
    }

    // ---------- Jupiter ----------

    /** Serialize calls to api.jup.ag to respect its per-second limit. */
    jupFetch(pathAndQuery) {
        const run = async () => {
            const wait = this.jupLastCall + this.jupMinGapMs - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            this.jupLastCall = Date.now();
            const res = await fetch(`${JUP_API}${pathAndQuery}`, { headers: this.jupHeaders, signal: AbortSignal.timeout(20000) });
            if (!res.ok) throw new Error(`Jupiter API ${res.status} for ${pathAndQuery.split('?')[0]}`);
            return res.json();
        };
        const p = this.jupQueue.then(run, run);
        this.jupQueue = p.catch(() => {});
        return p;
    }

    async refreshVerified() {
        try {
            const list = await this.jupFetch('/tokens/v2/tag?query=verified');
            const now = Date.now();
            for (const t of list) {
                if (!t?.id || !Number.isInteger(t.decimals)) continue;
                const builtin = BUILTIN[t.id];
                this.tokens.set(t.id, {
                    mint: t.id,
                    symbol: builtin?.symbol || cleanText(t.symbol, 24) || null,
                    name: builtin?.name || cleanText(t.name, 64) || null,
                    decimals: t.decimals,
                    icon: typeof t.icon === 'string' && /^https:\/\//.test(t.icon) ? t.icon : builtin?.icon || null,
                    verified: true,
                    liquidity: typeof t.liquidity === 'number' ? t.liquidity : null,
                    mcap: typeof t.mcap === 'number' ? t.mcap : null,
                    source: 'jupiter',
                });
                if (typeof t.usdPrice === 'number' && t.usdPrice > 0) this.setPrice(t.id, t.usdPrice, now);
            }
            console.log(`TokenRegistry: refreshed ${list.length} verified tokens from Jupiter`);
            this.scheduleSave();
        } catch (err) {
            console.error('TokenRegistry: verified list refresh failed:', err.message);
        }
    }

    startBackgroundRefresh() {
        this.refreshVerified();
        setInterval(() => this.refreshVerified(), VERIFIED_REFRESH_MS).unref();
    }

    // ---------- prices ----------

    setPrice(mint, usd, at) {
        const prev = this.prices.get(mint);
        if (!prev || prev.at <= at) this.prices.set(mint, { usd, at });
    }

    cachedPrice(mint) {
        return this.prices.get(mint)?.usd ?? null;
    }

    /**
     * USD prices for a handful of mints. Stale-while-revalidate: cached prices are returned
     * immediately and refreshed in the background; only mints with no price at all are waited on.
     */
    async getPrices(mints) {
        const now = Date.now();
        const unique = [...new Set(mints)];
        const stale = unique.filter(m => {
            const p = this.prices.get(m);
            return (!p || now - p.at > PRICE_TTL_MS) && !this.priceInflight.has(m);
        });
        const missing = unique.filter(m => !this.prices.has(m));
        if (stale.length) {
            const job = this.fetchPrices(stale);
            if (missing.length) {
                await Promise.race([job, new Promise(r => setTimeout(r, 4000))]);
            }
        }
        return Object.fromEntries(mints.map(m => [m, this.cachedPrice(m)]));
    }

    async fetchPrices(mints) {
        mints.forEach(m => this.priceInflight.add(m));
        try {
            for (let i = 0; i < mints.length; i += 50) {
                const chunk = mints.slice(i, i + 50);
                const data = await this.jupFetch(`/price/v3?ids=${chunk.join(',')}`);
                const at = Date.now();
                for (const [mint, info] of Object.entries(data || {})) {
                    if (typeof info?.usdPrice === 'number') this.setPrice(mint, info.usdPrice, at);
                }
            }
        } catch (err) {
            console.error('TokenRegistry: price fetch failed:', err.message);
        } finally {
            mints.forEach(m => this.priceInflight.delete(m));
        }
    }
}

export { SOL_MINT, USDC_MINT, USDT_MINT, shortMint };
