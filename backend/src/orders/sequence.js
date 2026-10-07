// The Manifest sequence number of the order a place transaction created (from its return data).
// The keeper needs it to tell whether the order is still resting before paying out.
import { connection } from '../solana.js';
import { parseBatchUpdateReturn } from '../venues/manifest/fills.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * { sequenceNumber, slot } for a landed place transaction, or null. Right after confirmation the
 * RPC may not have the transaction indexed yet (it returns null), so this retries for a while.
 */
export async function placedSequenceNumber(signature, { tries = 8, delayMs = 750 } = {}) {
    for (let i = 0; i < tries; i++) {
        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (tx) return { sequenceNumber: parseBatchUpdateReturn(tx.meta?.logMessages)?.[0] ?? null, slot: tx.slot };
        if (i < tries - 1) await sleep(delayMs);
    }
    return null;
}
