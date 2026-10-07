// One-off: add tax-ledger entries for activity from before the ledger existed (payout-account
// setups and order placements in data/orders.json), read back from the chain.
//
//   node backend/scripts/backfill-ledger.mjs           # dry run: prints what it would add
//   node backend/scripts/backfill-ledger.mjs --write   # appends them to data/ledger.json
//
// Idempotent (ledger keys), so running it twice adds nothing new. Stop the app first when
// writing (pm2 stop spot-aggregator), or the running app may overwrite the file with its own copy.
import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../src/solana.js';
import { config } from '../src/config.js';
import { Ledger, SOL_MINT } from '../src/orders/ledger.js';

const write = process.argv.includes('--write');
const saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'orders.json'), 'utf8'));
const ledger = new Ledger();
const planned = [];
const plan = (entry) => { if (!ledger.keys.has(entry.key) && !planned.some(p => p.key === entry.key)) planned.push(entry); };

// Payout accounts: the transaction that created each (its oldest signature) and its rent.
const nonceTx = new Map(); // signature -> { wallet, lamports, at }
for (const [address, info] of Object.entries(saved.nonces || {})) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 1000 });
    const first = sigs[sigs.length - 1];
    const acct = await connection.getAccountInfo(new PublicKey(address));
    if (!first || !acct) continue;
    const t = nonceTx.get(first.signature) || { wallet: info.wallet, lamports: 0, at: (first.blockTime || 0) * 1000 };
    t.lamports += acct.lamports;
    nonceTx.set(first.signature, t);
}

// Orders: the funds each placement deposited (its lock), plus any payout account it created.
const placeSigs = new Set();
for (const o of saved.orders || []) {
    if (!o.placeSignature || o.replaces) continue; // edits are recorded by the app from now on
    placeSigs.add(o.placeSignature);
    const rent = nonceTx.get(o.placeSignature)?.lamports || 0;
    plan({
        key: `place:${o.placeSignature}`, wallet: o.wallet, kind: 'place', at: o.createdAt, sig: o.placeSignature, market: o.market, orderId: o.id,
        moves: [{ mint: o.lockMint, atoms: o.lockAtoms, dir: 'in' }, { mint: SOL_MINT, atoms: rent, dir: 'in' }],
    });
    if (o.status === 'claimed' && o.claimSignature) {
        plan({ key: `fill:${o.id}:${o.baseAtoms}`, wallet: o.wallet, kind: 'fill', at: o.claimedAt, orderId: o.id, market: o.market, note: 'backfilled' });
    }
}
for (const [sig, t] of nonceTx) {
    if (placeSigs.has(sig)) continue; // created alongside an order: counted with it
    plan({ key: `setup:${sig}`, wallet: t.wallet, kind: 'setup', at: t.at, sig, moves: [{ mint: SOL_MINT, atoms: t.lamports, dir: 'in' }] });
}

const real = planned.filter(e => e.kind !== 'fill'); // fills of claimed orders: left to the app (needs trade details)
console.log(`${real.length} entr${real.length === 1 ? 'y' : 'ies'} to add:`);
for (const e of real) console.log(' ', new Date(e.at).toISOString(), e.kind, e.wallet.slice(0, 4), e.sig?.slice(0, 12), JSON.stringify(e.moves));
if (planned.length > real.length) console.log(`(${planned.length - real.length} already-paid-out orders need their fills added by hand)`);
if (!write) {
    console.log('\nDry run. Add --write (with the app stopped) to append these to data/ledger.json.');
} else {
    for (const e of real) ledger.add(e);
    console.log('\nWritten.');
}
process.exit(0);
