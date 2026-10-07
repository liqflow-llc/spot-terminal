// The Manifest sequence number of the order a place transaction created (from its return data).
// The keeper needs it to tell whether the order is still resting before paying out.
import { connection } from '../solana.js';
import { parseBatchUpdateReturn, parseFills } from '../venues/manifest/fills.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * { sequenceNumber, slot, fills } for a landed place transaction, or null. `fills` are the matches
 * it made on arrival (FillLog), at the resting orders' prices. Right after confirmation the
 * RPC may not have the transaction indexed yet (it returns null), so this retries for a while.
 */
export async function placedSequenceNumber(signature, { tries = 8, delayMs = 750 } = {}) {
    for (let i = 0; i < tries; i++) {
        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (tx) return { sequenceNumber: parseBatchUpdateReturn(tx.meta?.logMessages)?.[0] ?? null, slot: tx.slot, fills: parseFills(tx.meta?.logMessages) };
        if (i < tries - 1) await sleep(delayMs);
    }
    return null;
}

/**
 * What an order filled on arrival, taking resting orders (it was the taker): total base and quote
 * atoms at the prices those resting orders asked, or null if it didn't cross.
 */
export function takerFill(placed, order) {
    const mine = (placed?.fills || []).filter(f => f.taker === order.wallet && f.market === order.market);
    if (!mine.length) return null;
    return {
        baseAtoms: mine.reduce((s, f) => s + f.baseAtoms, 0n),
        quoteAtoms: mine.reduce((s, f) => s + f.quoteAtoms, 0n),
    };
}
