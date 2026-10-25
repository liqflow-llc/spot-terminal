// A raw JSON-RPC call, for provider methods web3.js doesn't wrap (e.g. Helius getProgramAccountsV2).
import { config } from './config.js';
import { countRpc, rpcFailed } from './rpcStats.js';

export const isHelius = /helius/i.test(config.rpcUrl);

export async function rpc(method, params) {
    countRpc(method);
    try {
        return await rawRpc(method, params);
    } catch (err) {
        rpcFailed(method, err);
        throw err;
    }
}

async function rawRpc(method, params) {
    const res = await fetch(config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
}
