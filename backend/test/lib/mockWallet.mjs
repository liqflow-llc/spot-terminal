// A Wallet Standard wallet for headless Chrome tests. The page never holds the key: it asks Node
// to sign. Behaves like a person with a wallet, controllable from the test:
//
//   window.__wallet.delayMs = 15000   // takes this long to approve (blockhash expiry, etc.)
//   window.__wallet.reject = true     // the user clicks Reject
//   window.__wallet.tamper = true     // the wallet changes the transaction before signing
//   window.__signCount                // approvals so far (one signAllTransactions = one approval)
//
// Signs legacy and versioned (v0) transactions, as real wallets do.
import { ComputeBudgetProgram, Transaction, VersionedTransaction } from '@solana/web3.js';

export async function installMockWallet(page, keypair) {
    await page.exposeFunction('__mockSign', (b64, tamper) => {
        const bytes = Buffer.from(b64, 'base64');
        const probe = VersionedTransaction.deserialize(bytes);
        if (probe.version === 'legacy') {
            const tx = Transaction.from(bytes);
            // Some wallets add or change compute-budget instructions before signing.
            if (tamper) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 }));
            tx.partialSign(keypair);
            return tx.serialize({ requireAllSignatures: false }).toString('base64');
        }
        if (tamper) probe.message.recentBlockhash = probe.message.recentBlockhash.replace(/^./, c => (c === '1' ? '2' : '1'));
        probe.sign([keypair]);
        return Buffer.from(probe.serialize()).toString('base64');
    });
    await page.evaluateOnNewDocument((address, pubkeyBytes) => {
        window.__wallet = { delayMs: 0, reject: false, tamper: false };
        const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
        const listeners = { change: new Set() };
        const account = {
            address,
            publicKey: new Uint8Array(pubkeyBytes),
            chains: ['solana:mainnet', 'solana:localnet'],
            features: ['solana:signTransaction', 'solana:signAndSendTransaction'],
        };
        const wallet = {
            version: '1.0.0',
            name: 'Mock Wallet',
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==',
            chains: ['solana:mainnet', 'solana:localnet'],
            accounts: [],
            features: {
                'standard:connect': {
                    version: '1.0.0',
                    connect: async () => {
                        wallet.accounts = [account];
                        listeners.change.forEach(fn => fn({ accounts: wallet.accounts }));
                        return { accounts: wallet.accounts };
                    },
                },
                'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
                'standard:events': {
                    version: '1.0.0',
                    on: (event, fn) => { listeners[event]?.add(fn); return () => listeners[event]?.delete(fn); },
                },
                'solana:signTransaction': {
                    version: '1.0.0',
                    supportedTransactionVersions: ['legacy', 0],
                    signTransaction: async (...inputs) => {
                        window.__signCount = (window.__signCount || 0) + 1; // one call = one approval
                        const { delayMs, reject, tamper } = window.__wallet;
                        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                        // What wallets throw when the user declines (wallet-adapter matches on it).
                        if (reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
                        const out = [];
                        for (const input of inputs) {
                            out.push({ signedTransaction: b64ToBytes(await window.__mockSign(bytesToB64(input.transaction), tamper)) });
                        }
                        return out;
                    },
                },
                'solana:signAndSendTransaction': {
                    version: '1.0.0',
                    supportedTransactionVersions: ['legacy', 0],
                    signAndSendTransaction: async () => { throw new Error('not used'); },
                },
            },
        };
        const register = ({ register: reg }) => reg(wallet);
        window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
        window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    }, keypair.publicKey.toBase58(), [...keypair.publicKey.toBytes()]);
}
