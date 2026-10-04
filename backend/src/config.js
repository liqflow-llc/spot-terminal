import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env') });

const heliusKey = process.env.HELIUS_API_KEY;
if (!heliusKey && !process.env.RPC_URL) {
    console.error('Set HELIUS_API_KEY (or RPC_URL + WS_URL) in .env');
    process.exit(1);
}

export const config = {
    root,
    dataDir: process.env.DATA_DIR || path.join(root, 'data'),
    port: Number(process.env.PORT) || 3020,
    host: process.env.HOST || '127.0.0.1',
    rpcUrl: process.env.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    wsUrl: process.env.WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    jupApiKey: process.env.JUP_API_KEY || '',
    // Keypair (JSON array file) that pays fees for submitting users' pre-signed claims.
    keeperKeypairPath: process.env.KEEPER_KEYPAIR || path.join(process.env.DATA_DIR || path.join(root, 'data'), 'keeper.json'),
    // Re-scan every Manifest market this often (one getProgramAccounts call).
    marketScanMs: Number(process.env.MARKET_SCAN_MS) || 60_000,
};
