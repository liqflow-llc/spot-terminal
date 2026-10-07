// One order book for a token pair, merged from every source that trades it: every Manifest
// market for the pair (pairs often have several, sometimes listed the other way round), plus
// other venues' books (Archer) passed in as `extra` sources with levels in the same shape.

const MAX_PAIR_MARKETS = 5;

/**
 * `minQuote` drops levels worth less than that many quote tokens.
 * @returns {{ bids, asks, sources, bestBid, bestAsk }} levels are [price, size, bySource]
 *   where bySource maps source id -> size at that price. Prices are quote per base of `primary`.
 */
export function aggregateBook(markets, primary, depth = 60, minQuote = 0, extra = []) {
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
    const all = [
        ...pair.map(m => ({ venue: 'manifest', market: m.address, baseMint: m.baseMint, levels: markets.levels(m.address) })),
        ...extra,
    ];
    for (const m of all) {
        const levels = m.levels;
        if (!levels) continue;
        const inverted = m.baseMint !== primary.baseMint;
        const id = `${m.venue}:${m.market}`;
        sources.push({ id, venue: m.venue, market: m.market, inverted, primary: m.market === primary.address });
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
    // Our orders rest on Manifest, so only Manifest levels say whether one fills on arrival.
    const onManifest = (level) => Object.keys(level[2]).some(id => id.startsWith('manifest:'));
    return {
        market: primary.address,
        bids: sortedBids,
        asks: sortedAsks,
        bestBid: sortedBids[0]?.[0] ?? null,
        bestAsk: sortedAsks[0]?.[0] ?? null,
        manifestBestBid: sortedBids.find(onManifest)?.[0] ?? null,
        manifestBestAsk: sortedAsks.find(onManifest)?.[0] ?? null,
        sources,
        time: Date.now(),
    };
}

/**
 * The individual Manifest orders behind one row of the merged book: `side` ('ask' | 'bid') orders
 * priced within [lo, hi] (quote per base of `primary`), across the same pair markets the book
 * merges, flipped markets converted the same way. Archer only publishes price levels, so it has
 * none to list. For "message this trader" links. Sorted best price first, at most `limit`.
 */
export function ordersAt(markets, primary, side, lo, hi, limit = 20) {
    const pair = markets.marketsForPair(primary.baseMint, primary.quoteMint).slice(0, MAX_PAIR_MARKETS);
    if (!pair.some(m => m.address === primary.address)) pair.unshift(primary);
    const eps = 1e-9;
    const out = [];
    for (const m of pair) {
        const market = markets.get(m.address);
        if (!market) continue;
        const inverted = m.baseMint !== primary.baseMint;
        // A bid for our quote token (paid in our base token) is an ask on our book, and vice versa.
        const list = (side === 'ask') !== inverted ? market.asks() : market.bids();
        for (const o of list) {
            const price = inverted ? 1 / o.tokenPrice : o.tokenPrice;
            if (!(price >= lo * (1 - eps) && price <= hi * (1 + eps))) continue;
            out.push({
                trader: o.trader.toBase58(),
                price,
                size: inverted ? o.numBaseTokens * o.tokenPrice : o.numBaseTokens,
                market: m.address,
            });
        }
    }
    out.sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price));
    return out.slice(0, limit);
}

