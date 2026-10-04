// Manifest market discovery, live order books and 24h stats.
//
// - Every market is re-scanned periodically with one getProgramAccounts call (~4k markets).
// - Markets someone is looking at (or that have a pending claim) get a websocket account
//   subscription, so their books update within a slot or two.
// - 24h volume comes from Manifest's on-chain lifetime quote-volume counter: we snapshot it
//   hourly and subtract the snapshot from ~24h ago.
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { ManifestClient, Market } from '@bonasa-tech/manifest-sdk';
import { connection } from '../../solana.js';
import { config } from '../../config.js';

export const MANIFEST_PROGRAM_ID = new PublicKey('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms');

const SNAPSHOT_FILE = path.join(config.dataDir, 'manifest-volume-snapshots.json');
const SNAPSHOT_EVERY_MS = 60 * 60 * 1000;
const SNAPSHOT_KEEP_MS = 26 * 60 * 60 * 1000;
const UNSUBSCRIBE_GRACE_MS = 60 * 1000;

export class ManifestMarkets extends EventEmitter {
    constructor() {
        super();
        this.markets = new Map();       // address -> Market (SDK object)
        this.summaries = new Map();     // address -> summary
        this.subscriptions = new Map(); // address -> { id, refs, timer }
        this.slot = 0;
        this.lastScan = 0;
        this.snapshots = this.loadSnapshots(); // [{ at, volumes: { market: quoteVolumeAtoms } }]
    }

    // ---------- scanning ----------

    async scan() {
        const started = Date.now();
        const [accounts, slot] = await Promise.all([
            ManifestClient.getMarketProgramAccounts(connection),
            connection.getSlot('confirmed'),
        ]);
        this.slot = slot;
        let parsed = 0;
        for (const { pubkey, account } of accounts) {
            const address = pubkey.toBase58();
            // Subscribed markets are kept current by their websocket; don't overwrite with older data.
            if (this.subscriptions.has(address) && this.markets.has(address)) continue;
            try {
                const market = Market.loadFromBuffer({ address: pubkey, buffer: account.data, slot });
                this.markets.set(address, market);
                this.summaries.set(address, summarize(address, market));
                parsed++;
            } catch {
                // Not a market account (or an unknown layout); skip it.
            }
        }
        this.lastScan = Date.now();
        this.maybeSnapshotVolumes();
        console.log(`Manifest: scanned ${accounts.length} accounts, ${parsed} markets parsed in ${Date.now() - started}ms`);
        this.emit('scan');
    }

    startScanning() {
        const run = () => this.scan().catch(err => console.error('Manifest scan failed:', err.message));
        const first = run();
        setInterval(run, config.marketScanMs).unref();
        return first;
    }

    // ---------- live subscriptions ----------

    /** Keep `address` live via websocket. Returns a release function. */
    subscribe(address) {
        let sub = this.subscriptions.get(address);
        if (sub) {
            sub.refs++;
            clearTimeout(sub.timer);
            sub.timer = null;
        } else {
            const pubkey = new PublicKey(address);
            const id = connection.onAccountChange(pubkey, (account, ctx) => {
                try {
                    const market = Market.loadFromBuffer({ address: pubkey, buffer: account.data, slot: ctx.slot });
                    this.slot = Math.max(this.slot, ctx.slot);
                    this.markets.set(address, market);
                    this.summaries.set(address, { ...summarize(address, market), volume24hAtoms: this.summaries.get(address)?.volume24hAtoms ?? null });
                    this.emit('update', address);
                } catch (err) {
                    console.error(`Manifest: failed to parse update for ${address}:`, err.message);
                }
            }, { commitment: 'confirmed', encoding: 'base64' });
            sub = { id, refs: 1, timer: null };
            this.subscriptions.set(address, sub);
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            sub.refs--;
            if (sub.refs > 0) return;
            sub.timer = setTimeout(() => {
                connection.removeAccountChangeListener(sub.id).catch(() => {});
                this.subscriptions.delete(address);
            }, UNSUBSCRIBE_GRACE_MS);
        };
    }

    /** Fetch one market fresh from the chain (used before building transactions). */
    async refresh(address) {
        const pubkey = new PublicKey(address);
        const info = await connection.getAccountInfo(pubkey, 'confirmed');
        if (!info) throw new Error(`Market ${address} not found`);
        const slot = await connection.getSlot('confirmed');
        const market = Market.loadFromBuffer({ address: pubkey, buffer: info.data, slot });
        this.markets.set(address, market);
        this.summaries.set(address, { ...summarize(address, market), volume24hAtoms: this.summaries.get(address)?.volume24hAtoms ?? null });
        return market;
    }

    // ---------- queries ----------

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
                console.error('Manifest: failed to save volume snapshots:', err.message);
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
