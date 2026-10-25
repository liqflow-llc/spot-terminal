// Trades worked out from two snapshots of a market account, instead of streaming every Manifest
// transaction's logs (~90k tx/hour, ~0.9 GB/hour: far too expensive on a metered RPC).
//
// What a snapshot pair tells us exactly:
// - the market's lifetime quote-volume counter, so the total traded between them;
// - resting orders that got smaller: partial fills, at the maker's price (Manifest fills at the
//   resting order's price, and there is no "reduce order" instruction).
// What is ambiguous: an order that disappeared was either filled or cancelled. The volume counter
// settles it: whatever volume the partial fills don't explain is assigned to vanished orders
// nearest the top of the book (fills consume the best prices first), as long as they fit. A taker
// can't skip a better-priced order that is still resting untouched, so vanished orders behind
// one are cancels, never fills (this is what keeps a cancelled dust bid far below the market
// from being recorded as a trade).
// Orders placed and filled entirely between two snapshots are invisible; their volume still
// counts in the 24h figure, which comes from the counter.

const VOLUME_TOLERANCE = 1.02; // rounding in Manifest's quote accounting
const MAX_DISTANCE_FROM_MID = 0.5; // fills further than this from the previous mid are not believed

/** @returns {{ price: number, size: number, quote: number, side: 'buy'|'sell' }[]} taker side */
export function inferFills(prev, next) {
    const volumeDelta = Number(next.quoteVolume()) - Number(prev.quoteVolume());
    if (!(volumeDelta > 0)) return [];
    const quoteScale = 10 ** next.quoteDecimals();

    const before = new Map();
    for (const o of prev.bids()) before.set(o.sequenceNumber.toString(), { o, isBid: true });
    for (const o of prev.asks()) before.set(o.sequenceNumber.toString(), { o, isBid: false });
    const after = new Map();
    for (const o of [...next.bids(), ...next.asks()]) after.set(o.sequenceNumber.toString(), o);

    const fills = [];
    let explained = 0;
    const vanished = [];
    // The best untouched order on each side: nothing behind it can have been filled.
    let barrierBid = -Infinity, barrierAsk = Infinity;
    for (const [seq, { o, isBid }] of before) {
        const now = after.get(seq);
        if (now && now.numBaseTokens >= o.numBaseTokens) {
            if (isBid) barrierBid = Math.max(barrierBid, o.tokenPrice);
            else barrierAsk = Math.min(barrierAsk, o.tokenPrice);
        }
    }
    for (const [seq, { o, isBid }] of before) {
        const now = after.get(seq);
        if (now) {
            const filled = o.numBaseTokens - now.numBaseTokens;
            if (filled > 0) {
                fills.push(fill(o.tokenPrice, filled, isBid));
                explained += o.tokenPrice * filled * quoteScale;
            }
        } else if (isBid ? o.tokenPrice >= barrierBid : o.tokenPrice <= barrierAsk) {
            vanished.push({ o, isBid });
        }
    }

    let residual = volumeDelta - explained;
    if (residual > 0 && vanished.length) {
        const bestBid = prev.bestBidPrice(), bestAsk = prev.bestAskPrice();
        // Distance from the touch, relative, so both sides can be ranked together.
        const distance = ({ o, isBid }) => (isBid
            ? (bestBid ? (bestBid - o.tokenPrice) / bestBid : 0)
            : (bestAsk ? (o.tokenPrice - bestAsk) / bestAsk : 0));
        vanished.sort((a, b) => distance(a) - distance(b));
        const limit = residual * VOLUME_TOLERANCE + 1;
        let used = 0;
        for (const v of vanished) {
            const quote = v.o.tokenPrice * v.o.numBaseTokens * quoteScale;
            if (used + quote > limit) continue;
            used += quote;
            fills.push(fill(v.o.tokenPrice, v.o.numBaseTokens, v.isBid));
            if (used >= residual) break;
        }
    }
    // Last line of defence against a mis-attributed cancel: trades far from the market are noise.
    const bestBid = prev.bestBidPrice(), bestAsk = prev.bestAskPrice();
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    return mid ? fills.filter(f => Math.abs(f.price / mid - 1) <= MAX_DISTANCE_FROM_MID) : fills;
}

function fill(price, size, makerIsBid) {
    // A resting bid is filled by a seller, a resting ask by a buyer.
    return { price, size, quote: price * size, side: makerIsBid ? 'sell' : 'buy' };
}
