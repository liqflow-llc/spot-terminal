// What each wallet moved into and out of SpotBook, and every fill inside it: the record the
// tax-software exports are built from (tax/exports.js).
//
// Tax apps see a wallet's own transactions, but a limit order's fill happens in someone else's
// transaction and its funds sit in the market's shared vault. So the exports describe SpotBook as
// an account of the user's: deposits into it (order funds, payout-account rent) and withdrawals
// out of it (payouts, cancels, refunds) carry the wallet transaction's hash, so the tax app pairs
// them with the wallet import as transfers; fills are trades inside it at the order's price.
//
// Entry: { key, wallet, at, kind, sig?, orderId?, market?, moves: [{ mint, atoms, dir }], trade? }
//   dir 'in'  = wallet -> SpotBook, 'out' = SpotBook -> wallet (atoms: positive integer string)
//   trade = { side, baseMint, quoteMint, baseAtoms, quoteAtoms, price } (side: the user's side)
//   external: true marks wallet-level swaps (Jupiter), which the tax apps read from the wallet itself.
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { log } from '../log.js';
import { quoteForBase } from '../venues/manifest/instructions.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class Ledger {
    constructor(file = path.join(config.dataDir, 'ledger.json')) {
        this.file = file;
        this.entries = [];
        this.keys = new Set();
        try {
            this.entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || [];
        } catch { /* first run */ }
        for (const e of this.entries) this.keys.add(e.key);
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ entries: this.entries }));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }

    /**
     * Record one event; `key` makes it idempotent (a retried claim or a re-run can't double-count).
     * Zero and missing moves are dropped.
     */
    add({ key, wallet, kind, at = Date.now(), moves = [], ...rest }) {
        if (!key || this.keys.has(key)) return null;
        const clean = moves
            .filter(m => m && m.mint && BigInt(m.atoms) > 0n)
            .map(m => ({ mint: m.mint, atoms: BigInt(m.atoms).toString(), dir: m.dir }));
        if (!clean.length && !rest.trade) return null;
        const entry = { key, wallet, kind, at, moves: clean, ...rest };
        this.entries.push(entry);
        this.keys.add(key);
        this.save();
        log.info('ledger', kind, { wallet: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`, moves: clean.length, trade: !!rest.trade });
        return entry;
    }

    forWallet(wallet) {
        return this.entries.filter(e => e.wallet === wallet).sort((a, b) => a.at - b.at);
    }
}

/**
 * An order has now filled `filledAtoms` base atoms in total: record what's new as a trade at the
 * order's own price (Manifest fills resting orders at their price, with no fee), or at
 * `quoteAtoms` when known exactly (an order that crossed on arrival fills at the resting orders'
 * prices). Idempotent.
 */
export function recordFill({ ledger, store, order, filledAtoms, quoteAtoms = null, at = Date.now() }) {
    const already = BigInt(order.filledAtoms || '0');
    const total = BigInt(filledAtoms);
    if (total <= already) return null;
    const delta = total - already;
    store.update(order.id, { filledAtoms: total.toString() });
    if (!ledger) return null;
    // The program rounds in the book's favour: a buyer pays rounded up, a seller gets rounded down.
    const quote = quoteAtoms != null ? BigInt(quoteAtoms) : quoteForBase(order.mantissa, order.exponent, delta, !!order.isBid);
    return ledger.add({
        key: `fill:${order.id}:${total}`, wallet: order.wallet, kind: 'fill', at, orderId: order.id, market: order.market,
        trade: {
            side: order.side, baseMint: order.baseMint, quoteMint: order.quoteMint,
            baseAtoms: delta.toString(), quoteAtoms: quote.toString(),
            // The average price of this fill (the order's own price unless it crossed on arrival).
            price: quoteAtoms != null ? (Number(quote) / 10 ** order.quoteDecimals) / (Number(delta) / 10 ** order.baseDecimals) : order.price,
        },
    });
}
