import { Connection } from '@solana/web3.js';
import { config } from './config.js';
import { countRpc, rpcFailed } from './rpcStats.js';

export const connection = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: config.wsUrl,
    // Rate limits surface as errors (and one log line) instead of web3.js retrying forever and
    // printing "Server responded with 429" every few seconds.
    disableRetryOnRateLimit: true,
});

// Count every call for the health line; flag provider limits loudly.
const request = connection._rpcRequest.bind(connection);
connection._rpcRequest = async (method, args) => {
    countRpc(method);
    try {
        return await request(method, args);
    } catch (err) {
        rpcFailed(method, err);
        throw err;
    }
};
const batch = connection._rpcBatchRequest?.bind(connection);
if (batch) {
    connection._rpcBatchRequest = async (requests) => {
        for (const r of requests) countRpc(r.methodName);
        return batch(requests);
    };
}
