// Archer (https://archer.exchange): an on-chain order book where each market maker runs their
// own book. We show its depth next to Manifest's so traders see where the real liquidity sits;
// orders are never placed on Archer (a user's resting book there only gets aggregator flow if
// Archer whitelists it, and fills stay in that book until withdrawn), and its liquidity is
// TAKEN through Jupiter, which routes to it.
//
// - Market list: Archer market accounts are 272 bytes with the base mint at byte 40 and the
//   quote mint at byte 72. One filtered program-accounts call, reading only those 64 bytes,
//   every few hours.
// - Books: Archer's public WebSocket (no key, no RPC credits). One connection; a market is
//   subscribed only while someone views its pair.
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../../solana.js';
import { isHelius, rpc } from '../../rpcRaw.js';

export const ARCHER_PROGRAM_ID = new PublicKey('Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy');
const STREAM_URL = 'wss://api.archer.exchange/v1/stream';
const MARKET_ACCOUNT_SIZE = 272;
const MINTS_OFFSET = 40;
const DISCOVER_EVERY_MS = 6 * 60 * 60 * 1000;
const PING_MS = 20_000;
const UNSUBSCRIBE_GRACE_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MIN_VOLUME_SHARE = 0.1;

export class ArcherVenue extends EventEmitter {
    constructor() {
        super();
        this.markets = new Map(); // address -> { address, baseMint, quoteMint }
        this.books = new Map();   // address -> { bids: Map<price string, size>, asks, seq, at }
        this.subs = new Map();    // address -> { refs, timer }
        this.activity = new Map(); // address -> { volume24h, lastPrice } from the mini_tickers feed
        this.ws = null;
        this.reconnectDelay = 1000;
    }

    start() {
        const run = () => this.discover().catch(err => console.error('Archer: market discovery failed:', err.message));
        run();
        setInterval(run, DISCOVER_EVERY_MS).unref();
        // Stay connected: the mini_tickers feed says which markets are actually trading.
        this.keepAlive = true;
        this.connect();
    }

    async discover() {
        const filters = [{ dataSize: MARKET_ACCOUNT_SIZE }];
        const dataSlice = { offset: MINTS_OFFSET, length: 64 };
        let list;
        if (isHelius) {
            list = [];
            let paginationKey = null;
            for (;;) {
                const cfg = { encoding: 'base64', limit: 10_000, filters, dataSlice, commitment: 'confirmed' };
                if (paginationKey) cfg.paginationKey = paginationKey;
                const res = await rpc('getProgramAccountsV2', [ARCHER_PROGRAM_ID.toBase58(), cfg]);
                const value = res.value ?? res;
                const page = value.accounts || [];
                for (const a of page) list.push({ pubkey: a.pubkey, data: Buffer.from(a.account.data[0], 'base64') });
                if (!page.length || !value.paginationKey) break;
                paginationKey = value.paginationKey;
            }
        } else {
            const accounts = await connection.getProgramAccounts(ARCHER_PROGRAM_ID, { filters, dataSlice, commitment: 'confirmed' });
            list = accounts.map(a => ({ pubkey: a.pubkey.toBase58(), data: a.account.data }));
        }
        this.markets.clear();
        for (const { pubkey, data } of list) {
            if (data.length < 64) continue;
            this.markets.set(pubkey, {
                address: pubkey,
                baseMint: new PublicKey(data.subarray(0, 32)).toBase58(),
                quoteMint: new PublicKey(data.subarray(32, 64)).toBase58(),
            });
        }
        console.log(`Archer: ${this.markets.size} markets`);
    }

    /**
     * Archer markets actively trading this pair, in either orientation, busiest first. Pairs can
     * have abandoned markets whose stale quotes would cross the real book, so only markets with
     * real 24h volume (at least a tenth of the busiest one's) count.
     */
    marketsForPair(mintA, mintB) {
        const vol = (m) => this.activity.get(m.address)?.volume24h ?? 0;
        const all = [...this.markets.values()]
            .filter(m => (m.baseMint === mintA && m.quoteMint === mintB) || (m.baseMint === mintB && m.quoteMint === mintA))
            .sort((a, b) => vol(b) - vol(a));
        const top = all[0] ? vol(all[0]) : 0;
        return top > 0 ? all.filter(m => vol(m) >= top * MIN_VOLUME_SHARE) : [];
    }

    /** Price levels as numbers, best first, or null until the first snapshot arrives. */
    levels(address) {
        const book = this.books.get(address);
        if (!book) return null;
        const side = (m, desc) => [...m].map(([p, s]) => [Number(p), Number(s)])
            .filter(([p, s]) => p > 0 && s > 0)
            .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]));
        return { bids: side(book.bids, true), asks: side(book.asks, false) };
    }

    // ---------- live books ----------

    /** Stream `address`'s book while someone needs it. Returns a release function. */
    subscribe(address) {
        let sub = this.subs.get(address);
        if (!sub) {
            this.subs.set(address, (sub = { refs: 0, timer: null }));
            this.send({ op: 'subscribe', channels: ['orderbook'], market: address });
        }
        clearTimeout(sub.timer);
        sub.timer = null;
        sub.refs++;
        this.connect();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--sub.refs > 0) return;
            sub.timer = setTimeout(() => {
                this.subs.delete(address);
                this.books.delete(address);
                this.send({ op: 'unsubscribe', channels: ['orderbook'], market: address });
            }, UNSUBSCRIBE_GRACE_MS);
        };
    }

    connect() {
        if (this.ws) return;
        const ws = new WebSocket(STREAM_URL);
        this.ws = ws;
        let ping = null;
        ws.on('open', () => {
            this.reconnectDelay = 1000;
            this.send({ op: 'subscribe', channels: ['mini_tickers'] });
            for (const address of this.subs.keys()) this.send({ op: 'subscribe', channels: ['orderbook'], market: address });
            ping = setInterval(() => this.send({ op: 'ping' }), PING_MS);
        });
        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (msg.ch === 'orderbook') this.onBook(msg);
            else if (msg.ch === 'mini_tickers') {
                for (const [address, t] of Object.entries(msg.data || {})) {
                    this.activity.set(address, { volume24h: Number(t.volume24h) || 0, lastPrice: Number(t.lastPrice) || null });
                }
            }
            else if (msg.op === 'reconnect') ws.close();
            else if (msg.op === 'error') console.error('Archer stream error:', JSON.stringify(msg).slice(0, 200));
        });
        ws.on('error', (err) => console.error('Archer stream:', err.message));
        ws.on('close', () => {
            clearInterval(ping);
            this.ws = null;
            this.books.clear();
            if (!this.subs.size && !this.keepAlive) return;
            setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        });
    }

    send(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    onBook(msg) {
        const address = msg.market;
        if (!this.subs.has(address)) return;
        if (msg.type === 'snapshot') {
            this.books.set(address, {
                bids: new Map((msg.bids || []).map(([p, s]) => [p, s])),
                asks: new Map((msg.asks || []).map(([p, s]) => [p, s])),
                seq: msg.sequenceId,
                at: Date.now(),
            });
        } else {
            const book = this.books.get(address);
            if (!book) return;
            if (msg.sequenceId != null && book.seq != null && msg.sequenceId > book.seq + 1) {
                // Missed an update: drop the book and ask for a fresh snapshot.
                this.books.delete(address);
                this.send({ op: 'unsubscribe', channels: ['orderbook'], market: address });
                this.send({ op: 'subscribe', channels: ['orderbook'], market: address });
                return;
            }
            for (const [side, levels] of [[book.bids, msg.bids], [book.asks, msg.asks]]) {
                for (const [p, s] of levels || []) {
                    if (Number(s) === 0) side.delete(p); else side.set(p, s);
                }
            }
            book.seq = msg.sequenceId ?? book.seq;
            book.at = Date.now();
        }
        this.emit('update', address);
    }
}
