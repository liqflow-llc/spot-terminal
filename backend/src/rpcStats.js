// Counts RPC calls by method (for the health line's Helius credit estimate) and turns the
// provider saying "out of credits" into one loud, de-duplicated log line.
import { log } from './log.js';

// Helius credit prices (https://www.helius.dev/docs/billing/credits); everything else is 1.
const CREDITS = { getProgramAccounts: 10, getProgramAccountsV2: 1, getAssetBatch: 10, getAsset: 10 };
const calls = new Map(); // method -> count since last take()

export function countRpc(method) {
    calls.set(method, (calls.get(method) || 0) + 1);
}

export function rpcFailed(method, err) {
    const msg = err?.message || String(err);
    if (/max usage|429/i.test(msg)) {
        log.error('rpc', /max usage/i.test(msg) ? 'OUT_OF_CREDITS' : 'rate_limited', { method, msg: msg.slice(0, 160) });
    } else {
        // Network blips etc. (web3.js also prints its own stack trace for these).
        log.warn('rpc', 'request_failed', { method, msg: msg.slice(0, 160) });
    }
}

/** { calls, credits, top } since the last call. */
export function takeRpcStats() {
    let total = 0, credits = 0;
    for (const [m, n] of calls) {
        total += n;
        credits += n * (CREDITS[m] ?? 1);
    }
    const top = [...calls].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, n]) => `${m}:${n}`).join(',');
    calls.clear();
    return { calls: total, credits, top };
}
