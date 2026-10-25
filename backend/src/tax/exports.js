// CSV exports of a wallet's SpotTerminal activity for crypto tax software, one file per app in the
// format that app documents for custom imports.
//
// The model: SpotTerminal is an account of the user's. Funds moving into it (order funds, payout
// account rent) are deposits; funds coming back (payouts, cancels, refunds) are withdrawals; both
// carry the wallet transaction's hash so the app pairs them with the user's imported Solana wallet
// as transfers between their own accounts (not sales). A limit order fill is a trade inside the
// account at the order's price. Jupiter swaps aren't here: they're ordinary wallet transactions
// that the apps' Solana import already understands.
//
// Formats (checked against each app's template / help article, October 2026):
//   Koinly      universal template; extended symbol notation SYMBOL:MINT:SOL picks the exact token
//   CoinTracker 8 fixed columns, no extra columns allowed (so no hash column)
//   CoinLedger  universal manual import template; Type is required on deposits / withdrawals
//   Awaken      awaken_csv_format plus its optional Transaction Hash / Tag columns; max 8 decimals
//   CoinTracking bulk import column order (Type, Buy, Sell, Fee, Exchange, Trade-Group, ...)
import { SOL_MINT } from '../orders/ledger.js';

export const TAX_APPS = ['koinly', 'cointracker', 'coinledger', 'awaken', 'cointracking'];

const PLATFORM = 'SpotTerminal';

/** 1234500n, 6 -> "1.2345" (exact, never exponent notation). */
function atomsToDecimal(atoms, decimals) {
    const s = BigInt(atoms).toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals) || '0', frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return decimals && frac ? `${whole}.${frac}` : whole;
}

/** "1.123456789" -> "1.12345678" (Awaken takes at most 8 decimal places; truncates, never rounds up). */
function maxDecimals(amount, places) {
    const [w, f = ''] = amount.split('.');
    const frac = f.slice(0, places).replace(/0+$/, '');
    return frac ? `${w}.${frac}` : w;
}

const pad = (n) => String(n).padStart(2, '0');
const parts = (ms) => {
    const d = new Date(ms);
    return { Y: d.getUTCFullYear(), M: pad(d.getUTCMonth() + 1), D: pad(d.getUTCDate()), h: pad(d.getUTCHours()), m: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()) };
};
const isoDate = (ms) => { const p = parts(ms); return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}`; };   // YYYY-MM-DD HH:mm:ss
const usDate = (ms) => { const p = parts(ms); return `${p.M}/${p.D}/${p.Y} ${p.h}:${p.m}:${p.s}`; };    // MM/DD/YYYY HH:MM:SS

const DESCRIBE = {
    setup: 'payout-account rent deposit (refundable)',
    place: 'funds for a limit order',
    edit: 'limit order changed',
    claim: 'filled order paid out',
    cancel: 'cancelled order, funds returned',
    cancelAll: 'cancelled orders, funds returned',
    withdraw: 'leftover funds withdrawn',
    closePayout: 'payout-account rent refunded',
    closeAccount: 'account closed, rent refunded',
};

/**
 * The ledger entries as neutral rows: { at, type: deposit|withdrawal|trade, sent?, received?,
 * txHash?, id, description } with sent/received = { amount, mint, symbol }.
 * token(mint) -> { symbol, decimals } (decimals must be known).
 */
export function buildRows(entries, token, { year = null } = {}) {
    const asset = (mint, atoms) => {
        const t = token(mint) || {};
        const decimals = Number.isInteger(t.decimals) ? t.decimals : (mint === SOL_MINT ? 9 : null);
        if (decimals == null) throw new Error(`unknown decimals for ${mint}`);
        return { amount: atomsToDecimal(atoms, decimals), mint, symbol: cleanSymbol(mint === SOL_MINT ? 'SOL' : t.symbol || mint.slice(0, 6)) };
    };
    const rows = [];
    for (const e of entries) {
        if (e.external) continue;
        if (year && new Date(e.at).getUTCFullYear() !== Number(year)) continue;
        if (e.trade) {
            const t = e.trade;
            const base = asset(t.baseMint, t.baseAtoms), quote = asset(t.quoteMint, t.quoteAtoms);
            const sell = t.side === 'sell';
            rows.push({
                at: e.at, type: 'trade', id: e.key,
                sent: sell ? base : quote, received: sell ? quote : base,
                description: `${PLATFORM} limit order ${t.side} ${base.amount} ${base.symbol} at ${Number(t.price).toPrecision(8).replace(/\.?0+$/, '')} ${quote.symbol} (order ${e.orderId?.slice(0, 8)})`,
            });
        }
        for (const [i, m] of (e.moves || []).entries()) {
            const a = asset(m.mint, m.atoms);
            rows.push({
                at: e.at, type: m.dir === 'in' ? 'deposit' : 'withdrawal', id: `${e.key}:${i}`, txHash: e.sig,
                [m.dir === 'in' ? 'received' : 'sent']: a,
                description: `${PLATFORM}: ${DESCRIBE[e.kind] || e.kind}`,
            });
        }
    }
    return rows.sort((a, b) => a.at - b.at);
}

function cleanSymbol(symbol) {
    // Plain ASCII: an unnamed token's placeholder "JBqw…2rhx" becomes "JBqw..2rhx".
    return String(symbol).replace(/…/g, '..').replace(/[,:"\n\r]/g, '').replace(/[^\x20-\x7e]/g, '').trim() || 'UNKNOWN';
}

function csv(header, lines) {
    const cell = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [header, ...lines].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Koinly picks the most popular token for a bare symbol; SYMBOL:MINT:SOL pins the exact one.
const koinlyCurrency = (a) => (a.mint === SOL_MINT ? 'SOL' : `${a.symbol}:${a.mint}:SOL`);
const label = (r) => ({ trade: 'Trade', deposit: 'Deposit', withdrawal: 'Withdrawal' }[r.type]);

const FORMATS = {
    koinly: (rows) => csv(
        ['Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency', 'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency', 'Tag', 'Description', 'TxHash'],
        rows.map(r => [isoDate(r.at), r.sent?.amount, r.sent && koinlyCurrency(r.sent), r.received?.amount, r.received && koinlyCurrency(r.received), '', '', '', '', '', r.description, r.txHash]),
    ),
    cointracker: (rows) => csv(
        ['Date', 'Received Quantity', 'Received Currency', 'Sent Quantity', 'Sent Currency', 'Fee Amount', 'Fee Currency', 'Tag'],
        rows.map(r => [usDate(r.at), r.received?.amount, r.received?.symbol, r.sent?.amount, r.sent?.symbol, '', '', '']),
    ),
    coinledger: (rows) => csv(
        ['Date (UTC)', 'Platform (Optional)', 'Asset Sent', 'Amount Sent', 'Asset Received', 'Amount Received', 'Fee Currency (Optional)', 'Fee Amount (Optional)', 'Type', 'Description (Optional)', 'TxHash (Optional)'],
        rows.map(r => [usDate(r.at), PLATFORM, r.sent?.symbol, r.sent?.amount, r.received?.symbol, r.received?.amount, '', '', label(r), r.description, r.txHash]),
    ),
    awaken: (rows) => csv(
        ['Date', 'Received Quantity', 'Received Currency', 'Sent Quantity', 'Sent Currency', 'Fee Amount', 'Fee Currency', 'Notes', 'Transaction Hash', 'Tag'],
        rows
            .map(r => ({ ...r, rq: r.received && maxDecimals(r.received.amount, 8), sq: r.sent && maxDecimals(r.sent.amount, 8) }))
            .filter(r => (r.rq == null || r.rq !== '0') && (r.sq == null || r.sq !== '0')) // dust below 8 decimals
            .map(r => [usDate(r.at), r.rq, r.received?.symbol, r.sq, r.sent?.symbol, '', '', `${r.description}${r.received ? ` [${r.received.mint}]` : ''}${r.sent ? ` [${r.sent.mint}]` : ''}`, r.txHash, '']),
    ),
    cointracking: (rows) => csv(
        ['Type', 'Buy Amount', 'Buy Currency', 'Sell Amount', 'Sell Currency', 'Fee', 'Fee Currency', 'Exchange', 'Trade-Group', 'Comment', 'Date', 'Liquidity Pool', 'Tx-ID'],
        // Tx-ID is unique per row so a re-import skips rows already imported.
        rows.map(r => [label(r), r.received?.amount, r.received?.symbol, r.sent?.amount, r.sent?.symbol, '', '', PLATFORM, PLATFORM, r.description, isoDate(r.at), '', r.txHash ? `${r.txHash}:${r.id.split(':').pop()}` : r.id]),
    ),
};

/** The CSV text for `app` from neutral rows. */
export function exportCsv(app, rows) {
    const f = FORMATS[app];
    if (!f) throw new Error(`unknown tax app ${app}`);
    return f(rows);
}
