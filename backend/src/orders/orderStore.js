// Persistent record of orders placed through this app, their pre-signed claims, and the
// durable-nonce accounts we created for each wallet. A plain JSON file: small, and it must
// survive restarts because it holds the claims the keeper still has to submit.
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { quoteForBase } from '../venues/manifest/instructions.js';

const FILE = path.join(config.dataDir, 'orders.json');

export const ACTIVE_STATUSES = new Set(['open', 'claiming']);

export class OrderStore {
    constructor() {
        this.orders = new Map(); // id -> order
        this.nonces = new Map(); // nonce address -> { wallet, createdAt }
        this.load();
    }

    load() {
        try {
            const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            for (const o of saved.orders || []) this.orders.set(o.id, o);
            for (const [k, v] of Object.entries(saved.nonces || {})) this.nonces.set(k, v);
            console.log(`OrderStore: ${this.orders.size} orders, ${this.nonces.size} nonce accounts`);
        } catch {
            // First run.
        }
    }

    save() {
        fs.mkdirSync(config.dataDir, { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ orders: [...this.orders.values()], nonces: Object.fromEntries(this.nonces) }, null, 1));
        fs.renameSync(tmp, FILE);
    }

    put(order) {
        order.updatedAt = Date.now();
        this.orders.set(order.id, order);
        this.save();
        return order;
    }

    update(id, patch) {
        const order = this.orders.get(id);
        if (!order) return null;
        return this.put(Object.assign(order, patch));
    }

    get(id) {
        return this.orders.get(id) || null;
    }

    forWallet(wallet) {
        return [...this.orders.values()].filter(o => o.wallet === wallet).sort((a, b) => b.createdAt - a.createdAt);
    }

    active() {
        return [...this.orders.values()].filter(o => ACTIVE_STATUSES.has(o.status));
    }

    addNonce(address, wallet) {
        this.nonces.set(address, { wallet, createdAt: Date.now() });
        this.save();
    }

    removeNonce(address) {
        this.nonces.delete(address);
        this.save();
    }

    noncesFor(wallet) {
        return [...this.nonces.entries()].filter(([, v]) => v.wallet === wallet).map(([k]) => k);
    }

    /** Nonce accounts currently backing a live claim. */
    noncesInUse(wallet) {
        return new Set(this.forWallet(wallet).filter(o => ACTIVE_STATUSES.has(o.status)).map(o => o.nonce));
    }
}

/**
 * Proceeds already sitting in a market seat that belong to this wallet's other live orders
 * (partial fills of resting orders, full fills awaiting their claim), in atoms.
 */
export function claimReservations(store, wallet, marketAddress, market, excludeOrderId) {
    const remaining = new Map([...market.bids(), ...market.asks()].map(o => [o.sequenceNumber.toString(), BigInt(o.numBaseAtoms.toString())]));
    const out = { base: 0n, quote: 0n };
    for (const o of store.active()) {
        if (o.wallet !== wallet || o.market !== marketAddress || o.id === excludeOrderId) continue;
        const total = BigInt(o.baseAtoms);
        const left = o.sequenceNumber && remaining.has(o.sequenceNumber) ? remaining.get(o.sequenceNumber) : 0n;
        const filled = total > left ? total - left : 0n;
        if (filled === 0n) continue;
        if (o.isBid) out.base += filled;
        else out.quote += left === 0n ? BigInt(o.claimAtoms) : quoteForBase(o.mantissa, o.exponent, filled, false);
    }
    return out;
}
