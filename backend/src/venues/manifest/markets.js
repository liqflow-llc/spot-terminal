// Manifest market discovery, live order books, trades and 24h stats.
//
// Everything is polled; nothing is streamed. RPC websockets are billed per MB, and Manifest is
// busy (~90k tx/hour, market accounts up to ~1 MB that change several times a second), so
// streaming cost hundreds of thousands of credits a day. Plain RPC calls cost 1 credit each:
// - Every market is re-scanned every minute, fetching only the accounts that changed since the
//   last scan (Helius getProgramAccountsV2 with changedSinceSlot): about 2 credits a scan.
// - Markets someone is looking at are polled together in one getMultipleAccounts call every few
//   seconds; markets that only have a pending payout are polled more slowly.
// - Trades are inferred by comparing successive snapshots (see inferFills.js).
// - 24h volume comes from Manifest's on-chain lifetime quote-volume counter: we snapshot it
//   hourly and subtract the snapshot from ~24h ago.
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { ManifestClient, Market } from '@bonasa-tech/manifest-sdk';
import { connection } from '../../solana.js';
import { config } from '../../config.js';
import { inferFills } from './inferFills.js';
import { isHelius, rpc } from '../../rpcRaw.js';
import { log } from '../../log.js';

export const MANIFEST_PROGRAM_ID = new PublicKey('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms');

const SNAPSHOT_FILE = path.join(config.dataDir, 'manifest-volume-snapshots.json');
const SNAPSHOT_EVERY_MS = 60 * 60 * 1000;
const SNAPSHOT_KEEP_MS = 26 * 60 * 60 * 1000;
const UNSUBSCRIBE_GRACE_MS = 60 * 1000;
const FULL_RESCAN_MS = 6 * 60 * 60 * 1000; // incremental scans can't see closed accounts
const POLL_TICK_MS = 1000;
const MAX_ACCOUNTS_PER_CALL = 100;
const V2_PAGE = 10_000;

export class ManifestMarkets extends EventEmitter {
    constructor() {
        super();
        this.markets = new Map();       // address -> Market (SDK object)
        this.raw = new Map();           // address -> account data last parsed (change detection)
        this.dataSlots = new Map();     // address -> slot of that data (never go back in time)
        this.summaries = new Map();     // address -> summary
        this.subscriptions = new Map(); // address -> { viewers, watchers, timer, polledAt }
        this.slot = 0;
        this.lastScan = 0;
        this.lastFullScan = 0;
        this.scanSlot = null;           // slot of the last successful scan (for changedSinceSlot)
        this.useV2 = isHelius;
        this.snapshots = this.loadSnapshots(); // [{ at, volumes: { market: quoteVolumeAtoms } }]
        this.polling = false;
    }

    // ---------- scanning ----------

    async scan() {
        const started = Date.now();
        const full = !this.scanSlot || started - this.lastFullScan > FULL_RESCAN_MS;
        const { accounts, slot } = await this.fetchProgramAccounts(full ? null : this.scanSlot);
        this.slot = Math.max(this.slot, slot);
        let parsed = 0;
        const seen = full ? new Set() : null;
        for (const { pubkey, data } of accounts) {
            const address = pubkey.toBase58();
            seen?.add(address);
            if (this.apply(address, data, slot)) parsed++;
        }
        if (full) {
            for (const address of [...this.markets.keys()]) {
                if (seen.has(address)) continue;
                this.markets.delete(address);
                this.summaries.delete(address);
                this.raw.delete(address);
                this.dataSlots.delete(address);
            }
            this.lastFullScan = started;
        }
        this.scanSlot = slot;
        this.lastScan = Date.now();
        this.maybeSnapshotVolumes();
        if (full || parsed > 0) this.lastScanSummary = { full, accounts: accounts.length, updated: parsed, ms: Date.now() - started };
        if (full) log.info('manifest', 'full_scan', { accounts: accounts.length, markets: this.markets.size, ms: Date.now() - started });
        this.emit('scan');
    }

    /** All Manifest program accounts, or only those changed since `sinceSlot`. */
    async fetchProgramAccounts(sinceSlot) {
        if (this.useV2) {
            try {
                return await this.fetchProgramAccountsV2(sinceSlot);
            } catch (err) {
                if (/429|max usage/i.test(err.message)) throw err;
                // Unexpected response: use the classic call (10 credits instead of ~2) from now on.
                log.error('manifest', 'v2_scan_failed_fallback', { msg: err.message });
                this.useV2 = false;
            }
        }
        // Plain RPC (local validator): getProgramAccounts has no incremental mode.
        const [list, slot] = await Promise.all([
            ManifestClient.getMarketProgramAccounts(connection),
            connection.getSlot('confirmed'),
        ]);
        return { accounts: list.map(({ pubkey, account }) => ({ pubkey, data: account.data })), slot };
    }

    async fetchProgramAccountsV2(sinceSlot) {
        const accounts = [];
        let paginationKey = null;
        let slot = null;
        for (;;) {
            const cfg = { encoding: 'base64', limit: V2_PAGE, commitment: 'confirmed', withContext: true };
            if (paginationKey) cfg.paginationKey = paginationKey;
            if (sinceSlot) cfg.changedSinceSlot = sinceSlot;
            const res = await rpc('getProgramAccountsV2', [MANIFEST_PROGRAM_ID.toBase58(), cfg]);
            const value = res.value ?? res;
            slot ??= res.context?.slot ?? await connection.getSlot('confirmed');
            const page = value.accounts;
            if (!Array.isArray(page)) throw new Error('unexpected getProgramAccountsV2 response');
            for (const a of page) accounts.push({ pubkey: new PublicKey(a.pubkey), data: Buffer.from(a.account.data[0], 'base64') });
            // Helius signals the end only with an empty page.
            if (!page.length || !value.paginationKey) break;
            paginationKey = value.paginationKey;
        }
        return { accounts, slot };
    }

    startScanning() {
        const run = () => this.scan().catch(err => log.error('manifest', 'scan_failed', { msg: err.message }));
        const first = run();
        setInterval(run, config.marketScanMs).unref();
        return first;
    }

    /**
     * Parse fresh account data for a market. Infers trades from the previous snapshot and emits
     * 'fills' and 'update'. Returns false if the data didn't change or isn't a market.
     */
    apply(address, data, slot) {
        if (slot < (this.dataSlots.get(address) ?? 0)) return false;
        const previous = this.raw.get(address);
        if (previous && previous.equals(data)) return false;
        let market;
        try {
            market = Market.loadFromBuffer({ address: new PublicKey(address), buffer: data, slot });
        } catch {
            return false; // not a market account (or an unknown layout)
        }
        const before = this.markets.get(address);
        this.markets.set(address, market);
        this.raw.set(address, data);
        this.dataSlots.set(address, slot);
        this.summaries.set(address, {
            ...summarize(address, market),
            volume24hAtoms: this.summaries.get(address)?.volume24hAtoms ?? null,
            volumeWindowHours: this.summaries.get(address)?.volumeWindowHours ?? null,
        });
        if (before) {
            const fills = inferFills(before, market);
            if (fills.length) this.emit('fills', address, fills);
        }
        this.emit('update', address);
        return true;
    }

    // ---------- live markets (polled) ----------

    /**
     * Keep `address` fresh. Viewers (someone has the page open) are polled every
     * config.viewPollMs; watchers (only a pending payout) every config.watchPollMs.
     * Returns a release function.
     */
    subscribe(address, { viewer = true } = {}) {
        this.pollTimer ??= setInterval(() => this.poll(), POLL_TICK_MS).unref();
        let sub = this.subscriptions.get(address);
        if (!sub) this.subscriptions.set(address, (sub = { viewers: 0, watchers: 0, timer: null, polledAt: 0 }));
        clearTimeout(sub.timer);
        sub.timer = null;
        if (viewer) sub.viewers++; else sub.watchers++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (viewer) sub.viewers--; else sub.watchers--;
            if (sub.viewers + sub.watchers > 0) return;
            sub.timer = setTimeout(() => this.subscriptions.delete(address), UNSUBSCRIBE_GRACE_MS);
        };
    }

    async poll() {
        if (this.polling) return;
        const now = Date.now();
        const due = [];
        for (const [address, sub] of this.subscriptions) {
            if (sub.viewers + sub.watchers === 0) continue;
            const every = sub.viewers > 0 ? config.viewPollMs : config.watchPollMs;
            if (now - sub.polledAt >= every) due.push(address);
        }
        if (!due.length) return;
        this.polling = true;
        try {
            for (let i = 0; i < due.length; i += MAX_ACCOUNTS_PER_CALL) {
                const chunk = due.slice(i, i + MAX_ACCOUNTS_PER_CALL);
                const res = await connection.getMultipleAccountsInfoAndContext(chunk.map(a => new PublicKey(a)), 'confirmed');
                this.slot = Math.max(this.slot, res.context.slot);
                chunk.forEach((address, j) => {
                    const sub = this.subscriptions.get(address);
                    if (sub) sub.polledAt = now;
                    const info = res.value[j];
                    if (info) this.apply(address, info.data, res.context.slot);
                });
            }
        } catch (err) {
            log.warn('manifest', 'poll_failed', { msg: err.message });
        } finally {
            this.polling = false;
        }
    }

    /** Fetch one market fresh from the chain (used before building transactions). */
    async refresh(address) {
        const pubkey = new PublicKey(address);
        const res = await connection.getAccountInfoAndContext(pubkey, 'confirmed');
        if (!res.value) throw new Error(`Market ${address} not found`);
        this.slot = Math.max(this.slot, res.context.slot);
        this.apply(address, res.value.data, res.context.slot);
        const market = this.markets.get(address);
        if (!market) throw new Error(`Market ${address} could not be parsed`);
        return market;
    }

    // ---------- queries ----------

    /**
     * Every resting order on a market INCLUDING expired ones. Market.bids()/asks() hide expired
     * orders, but they still hold their owner's funds on-chain until cancelled.
     */
    allOrders(address) {
        const raw = this.raw.get(address);
        if (!raw) return [];
        const m = Market.loadFromBuffer({ address: new PublicKey(address), buffer: raw }); // no slot: nothing filtered
        return [...m.bids(), ...m.asks()];
    }

    get(address) {
        return this.markets.get(address) || null;
    }

    summary(address) {
        return this.summaries.get(address) || null;
    }

    allSummaries() {
        return [...this.summaries.values()];
    }

    /** Markets trading this mint pair in either orientation, busiest first. */
    marketsForPair(mintA, mintB) {
        return this.allSummaries()
            .filter(s => (s.baseMint === mintA && s.quoteMint === mintB) || (s.baseMint === mintB && s.quoteMint === mintA))
            .sort((a, b) => (b.volume24hAtoms ?? b.quoteVolumeAtoms) - (a.volume24hAtoms ?? a.quoteVolumeAtoms));
    }

    /**
     * Price levels for a market, best first: { bids: [[price, size, orders]], asks: [...] }.
     * Prices are quote tokens per base token; sizes are base tokens. Expired orders are skipped.
     */
    levels(address) {
        const market = this.markets.get(address);
        if (!market) return null;
        return {
            bids: aggregate(market.bids(), this.slot, true),
            asks: aggregate(market.asks(), this.slot, false),
        };
    }

    // ---------- 24h volume from lifetime counters ----------

    loadSnapshots() {
        try {
            return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
        } catch {
            return [];
        }
    }

    maybeSnapshotVolumes() {
        const now = Date.now();
        const last = this.snapshots.at(-1);
        if (!last || now - last.at >= SNAPSHOT_EVERY_MS) {
            const volumes = {};
            for (const s of this.summaries.values()) volumes[s.address] = s.quoteVolumeAtoms;
            this.snapshots.push({ at: now, volumes });
            this.snapshots = this.snapshots.filter(s => now - s.at <= SNAPSHOT_KEEP_MS);
            try {
                fs.mkdirSync(config.dataDir, { recursive: true });
                fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(this.snapshots));
            } catch (err) {
                log.warn('manifest', 'snapshot_save_failed', { msg: err.message });
            }
        }
        // Oldest snapshot within the last 24h (or the oldest we have, if younger than 24h).
        const target = now - 24 * 60 * 60 * 1000;
        const base = this.snapshots.find(s => s.at >= target) || this.snapshots[0];
        const windowMs = base ? now - base.at : 0;
        for (const s of this.summaries.values()) {
            const then = base?.volumes[s.address];
            s.volume24hAtoms = then !== undefined && windowMs > 0 ? Math.max(0, s.quoteVolumeAtoms - then) : null;
            s.volumeWindowHours = Math.round(windowMs / 36e5);
        }
    }
}

function summarize(address, market) {
    const bestBid = market.bestBidPrice() ?? null;
    const bestAsk = market.bestAskPrice() ?? null;
    return {
        venue: 'manifest',
        address,
        baseMint: market.baseMint().toBase58(),
        quoteMint: market.quoteMint().toBase58(),
        baseDecimals: market.baseDecimals(),
        quoteDecimals: market.quoteDecimals(),
        bestBid,
        bestAsk,
        bidCount: market.bids().length,
        askCount: market.asks().length,
        quoteVolumeAtoms: Number(market.quoteVolume()),
        volume24hAtoms: null,
    };
}

function aggregate(orders, currentSlot, isBid) {
    const byPrice = new Map();
    for (const o of orders) {
        const lastValid = Number(o.lastValidSlot);
        if (lastValid !== 0 && lastValid < currentSlot) continue;
        const price = Number(o.tokenPrice);
        const size = Number(o.numBaseTokens);
        if (!(price > 0) || !(size > 0)) continue;
        const level = byPrice.get(price);
        if (level) {
            level[1] += size;
            level[2]++;
        } else {
            byPrice.set(price, [price, size, 1]);
        }
    }
    return [...byPrice.values()].sort((a, b) => (isBid ? b[0] - a[0] : a[0] - b[0]));
}
