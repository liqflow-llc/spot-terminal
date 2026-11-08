import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env') });

// RPC: HELIUS_API_KEY, else RPC_URL/WS_URL, else the shared Helius key below. The shared key is a
// free-plan key the project publishes so anyone can run the app locally without signing up for
// anything; it is shared by everyone running it, so it can hit its monthly limit (and may be
// rotated or removed). For anything beyond trying it out, put your own free key in .env
// (https://dashboard.helius.dev).
const SHARED_HELIUS_KEY = 'e1607f59-37d4-4b4a-80f1-7f02899a5f90';
const heliusKey = process.env.HELIUS_API_KEY || (process.env.RPC_URL ? '' : SHARED_HELIUS_KEY);
if (!process.env.HELIUS_API_KEY && !process.env.RPC_URL) {
    console.warn('No HELIUS_API_KEY or RPC_URL in .env: using the shared Helius key (fine for trying it out; get your own free key at https://dashboard.helius.dev).');
}
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const defaultRpc = (scheme) => (heliusKey ? `${scheme}://mainnet.helius-rpc.com/?api-key=${heliusKey}` : PUBLIC_RPC.replace('https', scheme));

export const config = {
    root,
    dataDir: process.env.DATA_DIR || path.join(root, 'data'),
    port: Number(process.env.PORT) || 3020,
    host: process.env.HOST || '127.0.0.1',
    rpcUrl: process.env.RPC_URL || defaultRpc('https'),
    wsUrl: process.env.WS_URL || defaultRpc('wss'),
    jupApiKey: process.env.JUP_API_KEY || '',
    // Keypair (JSON array file) that pays fees for submitting users' pre-signed claims.
    keeperKeypairPath: process.env.KEEPER_KEYPAIR || path.join(process.env.DATA_DIR || path.join(root, 'data'), 'keeper.json'),
    // Re-scan every Manifest market this often (one getProgramAccounts call).
    marketScanMs: Number(process.env.MARKET_SCAN_MS) || 60_000,
    // Public name and URL for link previews (keep in sync with frontend/src/brand.js).
    brand: process.env.BRAND || 'SpotTerminal',
    publicUrl: process.env.PUBLIC_URL || '', // empty: derived from the request's Host
    // Polling of markets being viewed / only awaiting a payout (each poll is 1 RPC credit total).
    viewPollMs: Number(process.env.VIEW_POLL_MS) || 3_000,
    watchPollMs: Number(process.env.WATCH_POLL_MS) || 15_000,
};
