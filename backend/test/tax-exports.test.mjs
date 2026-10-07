// Unit test for the tax-software CSV exports: each app's exact header row (as in its official
// template), date format, and how deposits, withdrawals and trades are written.
//   cd backend && node test/tax-exports.test.mjs
import assert from 'assert/strict';
import { buildRows, exportCsv, TAX_APPS } from '../src/tax/exports.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const W = '7KUV422Du16ndpsZYWWXoyAJqP2XDZ4Je7d77kJa248U';
const tokens = { [SOL]: { symbol: 'SOL', decimals: 9 }, [USDC]: { symbol: 'USDC', decimals: 6 }, [BONK]: { symbol: 'Bonk', decimals: 5 } };
const token = (m) => tokens[m];
const t0 = Date.UTC(2026, 9, 7, 1, 14, 39); // 2026-10-07 01:14:39 UTC

// A first order: setup, a sell of 0.01 SOL at 120 USDC that fills and pays out, then a closed account.
const entries = [
    { key: 'setup:SIG1', wallet: W, kind: 'setup', at: t0, sig: 'SIG1', moves: [{ mint: SOL, atoms: '2895360', dir: 'in' }] },
    { key: 'place:SIG2', wallet: W, kind: 'place', at: t0 + 10_000, sig: 'SIG2', moves: [{ mint: SOL, atoms: '10000000', dir: 'in' }] },
    { key: 'fill:o1:10000000', wallet: W, kind: 'fill', at: t0 + 3_600_000, orderId: 'o1abcdef-1', trade: { side: 'sell', baseMint: SOL, quoteMint: USDC, baseAtoms: '10000000', quoteAtoms: '1200000', price: 120 } },
    { key: 'claim:SIG3', wallet: W, kind: 'claim', at: t0 + 3_601_000, sig: 'SIG3', moves: [{ mint: USDC, atoms: '1199990', dir: 'out' }] },
    { key: 'fill:o2:150000', wallet: W, kind: 'fill', at: Date.UTC(2027, 0, 2), orderId: 'o2', trade: { side: 'buy', baseMint: BONK, quoteMint: USDC, baseAtoms: '150000', quoteAtoms: '3', price: 0.00002 } },
    { key: 'closeAccount:SIG4', wallet: W, kind: 'closeAccount', at: Date.UTC(2027, 0, 3), sig: 'SIG4', moves: [{ mint: SOL, atoms: '2895360', dir: 'out' }] },
    { key: 'swap:X', wallet: W, kind: 'swap', at: t0, external: true, moves: [{ mint: SOL, atoms: '1', dir: 'in' }] },
];

const rows = buildRows(entries, token);
assert.equal(rows.length, 6, 'external swaps are left to the wallet import');
assert.deepEqual(rows.map(r => r.type), ['deposit', 'deposit', 'trade', 'withdrawal', 'trade', 'withdrawal']);
assert.equal(buildRows(entries, token, { year: 2027 }).length, 2, 'year filter (UTC)');

const files = Object.fromEntries(TAX_APPS.map(a => [a, exportCsv(a, rows).split('\r\n')]));
const line = (app, i) => files[app][i];

// Koinly universal template + extended symbol notation.
assert.equal(line('koinly', 0), 'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Tag,Description,TxHash');
assert.equal(line('koinly', 1), '2026-10-07 01:14:39,,,0.00289536,SOL,,,,,,SpotBook: payout-account rent deposit (refundable),SIG1');
assert.match(line('koinly', 3), /^2026-10-07 02:14:39,0\.01,SOL,1\.2,USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:SOL,/);
assert.match(line('koinly', 4), /^2026-10-07 02:14:40,1\.19999,USDC:EPjF\w+:SOL,,,.*,SIG3$/);

// CoinTracker: exactly its 8 columns, US date, tickers.
assert.equal(line('cointracker', 0), 'Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag');
assert.equal(line('cointracker', 3), '10/07/2026 02:14:39,1.2,USDC,0.01,SOL,,,');
assert.equal(line('cointracker', 4), '10/07/2026 02:14:40,,,1.19999,USDC,,,');

// CoinLedger universal manual import: Type on every deposit / withdrawal.
assert.equal(line('coinledger', 0), 'Date (UTC),Platform (Optional),Asset Sent,Amount Sent,Asset Received,Amount Received,Fee Currency (Optional),Fee Amount (Optional),Type,Description (Optional),TxHash (Optional)');
assert.match(line('coinledger', 1), /^10\/07\/2026 01:14:39,SpotBook,,,SOL,0\.00289536,,,Deposit,/);
assert.match(line('coinledger', 3), /^10\/07\/2026 02:14:39,SpotBook,SOL,0\.01,USDC,1\.2,,,Trade,/);
assert.match(line('coinledger', 6), /,Withdrawal,.*,SIG4$/);

// Awaken: its columns plus Transaction Hash and Tag; at most 8 decimals.
assert.equal(line('awaken', 0), 'Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Notes,Transaction Hash,Tag');
assert.match(line('awaken', 1), /^10\/07\/2026 01:14:39,0\.00289536,SOL,,,/);
assert.match(line('awaken', 5), /^01\/02\/2027 00:00:00,1\.5,Bonk,0\.000003,USDC,/);

// CoinTracking bulk import order; deposits buy, withdrawals sell; unique Tx-ID per row.
assert.equal(line('cointracking', 0), 'Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Liquidity Pool,Tx-ID');
assert.match(line('cointracking', 1), /^Deposit,0\.00289536,SOL,,,,,SpotBook,SpotBook,.*,2026-10-07 01:14:39,,SIG1:0$/);
assert.match(line('cointracking', 3), /^Trade,1\.2,USDC,0\.01,SOL,,,SpotBook,SpotBook,/);
assert.match(line('cointracking', 4), /^Withdrawal,,,1\.19999,USDC,/);
const ids = files.cointracking.slice(1).filter(Boolean).map(l => l.split(',').pop());
assert.equal(new Set(ids).size, ids.length, 'Tx-IDs are unique');

// Commas and quotes in descriptions are quoted, never break columns.
const odd = exportCsv('koinly', buildRows([{ ...entries[0], key: 'k', kind: 'weird, "kind"' }], token));
assert.equal(odd.split('\r\n')[1].split(',').length >= 12, true);
assert.match(odd, /"SpotBook: weird, ""kind"""/);

console.log('tax exports: all formats OK');
for (const a of TAX_APPS) console.log(`\n--- ${a} ---\n${files[a].slice(0, 5).join('\n')}`);
