// One order book for a token pair, merged from every source that trades it.
// Today that is every Manifest market for the pair (pairs often have several, sometimes listed
// the other way round); other venues plug in by contributing levels in the same shape.

const MAX_PAIR_MARKETS = 5;

/**
 * `minQuote` drops levels worth less than that many quote tokens.
 * @returns {{ bids, asks, sources, bestBid, bestAsk }} levels are [price, size, bySource]
 *   where bySource maps source id -> size at that price. Prices are quote per base of `primary`.
 */
export function aggregateBook(markets, primary, depth = 60, minQuote = 0) {
    const sources = [];
    const bids = new Map();
    const asks = new Map();
    const add = (side, price, size, sourceId) => {
        // Skip dust (abandoned markets often hold crumbs priced far through the real book).
        if (!(price > 0) || !(size > 0) || price * size < minQuote) return;
        const key = Number(price.toPrecision(10));
        const level = side.get(key);
        if (level) {
            level[1] += size;
            level[2][sourceId] = (level[2][sourceId] || 0) + size;
        } else {
            side.set(key, [key, size, { [sourceId]: size }]);
        }
    };

    const pair = markets.marketsForPair(primary.baseMint, primary.quoteMint).slice(0, MAX_PAIR_MARKETS);
    if (!pair.some(m => m.address === primary.address)) pair.unshift(primary);
    for (const m of pair) {
        const levels = markets.levels(m.address);
        if (!levels) continue;
        const inverted = m.baseMint !== primary.baseMint;
        const id = `manifest:${m.address}`;
        sources.push({ id, venue: 'manifest', market: m.address, inverted, primary: m.address === primary.address });
        if (!inverted) {
            for (const [p, s] of levels.bids) add(bids, p, s, id);
            for (const [p, s] of levels.asks) add(asks, p, s, id);
        } else {
            // A bid for our quote token paid in our base token is an ask on our book, and vice versa.
            for (const [p, s] of levels.bids) add(asks, 1 / p, s * p, id);
            for (const [p, s] of levels.asks) add(bids, 1 / p, s * p, id);
        }
    }

    const sortedBids = [...bids.values()].sort((a, b) => b[0] - a[0]).slice(0, depth);
    const sortedAsks = [...asks.values()].sort((a, b) => a[0] - b[0]).slice(0, depth);
    return {
        market: primary.address,
        bids: sortedBids,
        asks: sortedAsks,
        bestBid: sortedBids[0]?.[0] ?? null,
        bestAsk: sortedAsks[0]?.[0] ?? null,
        sources,
        time: Date.now(),
    };
}
