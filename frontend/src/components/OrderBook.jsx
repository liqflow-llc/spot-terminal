import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount, formatPrice, priceDecimals, shortAddress } from '../utils/format';
import './OrderBook.css';

const ROW_HEIGHT = 20;

/** Merge levels onto a tick grid: asks round up, bids round down (never improves a price). */
function group(levels, tick, isBid) {
  if (!tick) return levels;
  const out = new Map();
  for (const [price, size, sources] of levels) {
    const k = isBid ? Math.floor(price / tick + 1e-9) * tick : Math.ceil(price / tick - 1e-9) * tick;
    const key = Number(k.toPrecision(12));
    const level = out.get(key);
    if (level) {
      level[1] += size;
      for (const [s, v] of Object.entries(sources)) level[2][s] = (level[2][s] || 0) + v;
    } else {
      out.set(key, [key, size, { ...sources }]);
    }
  }
  return [...out.values()].sort((a, b) => (isBid ? b[0] - a[0] : a[0] - b[0]));
}

export default function OrderBook({ book, market, onPick }) {
  const bodyRef = useRef(null);
  const [rows, setRows] = useState(12);
  const ref = book?.bestBid ?? book?.bestAsk ?? market?.last;
  const baseDecimals = priceDecimals(ref);
  const ticks = useMemo(() => {
    const t = 10 ** -baseDecimals;
    return [t, t * 10, t * 100, t * 1000];
  }, [baseDecimals]);
  const [tickIdx, setTickIdx] = useState(0);
  useEffect(() => setTickIdx(0), [market?.address]);
  const tick = ticks[tickIdx];
  const decimals = Math.max(0, baseDecimals - tickIdx);

  // Fit as many rows as the panel has room for, split between asks and bids.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setRows(Math.max(4, Math.floor((el.clientHeight - 44) / ROW_HEIGHT / 2))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { asks, bids, maxCum } = useMemo(() => {
    if (!book) return { asks: [], bids: [], maxCum: 0 };
    const cumulate = (levels) => {
      let c = 0;
      return levels.map(l => ({ price: l[0], size: l[1], sources: l[2], cum: (c += l[1]) }));
    };
    const a = cumulate(group(book.asks, tick, false).slice(0, rows));
    const b = cumulate(group(book.bids, tick, true).slice(0, rows));
    return { asks: a, bids: b, maxCum: Math.max(a.at(-1)?.cum || 0, b.at(-1)?.cum || 0) };
  }, [book, tick, rows]);

  const sourceCount = book?.sources?.length || 0;
  const spread = book?.bestAsk && book?.bestBid ? book.bestAsk - book.bestBid : null;

  const row = (l, side) => (
    <button
      type="button"
      key={`${side}${l.price}`}
      className={`ob-row ${side}`}
      style={{ '--depth': `${maxCum ? (l.cum / maxCum) * 100 : 0}%` }}
      onClick={() => onPick?.(l.price)}
      title={sourceCount > 1 ? Object.entries(l.sources).map(([s, v]) => `${shortAddress(s.split(':')[1])}: ${formatAmount(v)}`).join('\n') : undefined}
    >
      <span className={`num ${side}`}>{formatPrice(l.price, decimals)}</span>
      <span className="num">{formatAmount(l.size)}</span>
      <span className="num muted">{formatAmount(l.price * l.size)}</span>
    </button>
  );

  return (
    <>
      <div className="panel-title">
        <span>Order book</span>
        <select className="ob-tick" value={tickIdx} onChange={e => setTickIdx(Number(e.target.value))} aria-label="Price grouping">
          {ticks.map((t, i) => <option key={t} value={i}>{formatPrice(t, Math.max(0, baseDecimals - i))}</option>)}
        </select>
      </div>
      <div className="ob-head">
        <span>Price ({market?.quote.symbol || '—'})</span>
        <span>Amount ({market?.base.symbol || '—'})</span>
        <span>Total</span>
      </div>
      <div className="ob-body" ref={bodyRef}>
        {!book ? (
          <div className="ob-empty"><span className="spinner" /></div>
        ) : (
          <>
            <div className="ob-side asks">{[...asks].reverse().map(l => row(l, 'ask'))}</div>
            <div className="ob-mid">
              <span className="num ob-last">{formatPrice(market?.last, decimals)}</span>
              {spread != null && (
                <span className="muted num">Spread {formatPrice(spread, decimals)} ({((spread / book.bestAsk) * 100).toFixed(3)}%)</span>
              )}
            </div>
            <div className="ob-side bids">{bids.map(l => row(l, 'bid'))}</div>
          </>
        )}
      </div>
      {sourceCount > 1 && (
        <div className="ob-foot muted" title={book.sources.map(s => `${s.venue} ${s.market}${s.inverted ? ' (inverted)' : ''}`).join('\n')}>
          Aggregated from {sourceCount} Manifest markets for this pair
        </div>
      )}
    </>
  );
}
