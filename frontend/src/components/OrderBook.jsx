import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount, formatPrice, priceDecimals } from '../utils/format';
import './OrderBook.css';
import { VENUE_INFO } from '../venues';
import Tooltip from './Tooltip.jsx';
import { useWallet } from '@solana/wallet-adapter-react';
import { getJSON } from '../services/api';
import { SITE } from '../brand';

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
  const hasArcher = book?.sources?.some(s => s.venue === 'archer' && s.market) && [...(book?.bids || []), ...(book?.asks || [])].some(l => Object.keys(l[2]).some(id => id.startsWith('archer:')));
  const spread = book?.bestAsk && book?.bestBid ? book.bestAsk - book.bestBid : null;

  // Who is behind a row: the wallets with Manifest orders at that price (W2W Chat links).
  const [traders, setTraders] = useState(null); // { rect, side, price, lo, hi }
  useEffect(() => setTraders(null), [market?.address, tick]);

  const row = (l, side) => (
    <div className="ob-row-wrap" key={`${side}${l.price}`}>
      <button
        type="button"
        className={`ob-row ${side}`}
        style={{ '--depth': `${maxCum ? (l.cum / maxCum) * 100 : 0}%` }}
        onClick={() => onPick?.(l.price)}
      >
        <span className={`num ${side}`}>
          {formatPrice(l.price, decimals)}
          {Object.keys(l.sources).some(id => id.startsWith('archer:')) && <span className="venue-badge archer" aria-label="Includes Archer orders">A</span>}
        </span>
        <span className="num">{formatAmount(l.size)}</span>
        <span className="num muted">{formatAmount(l.price * l.size)}</span>
      </button>
      {Object.keys(l.sources).some(id => id.startsWith('manifest:')) && (
        <button
          type="button"
          className="ob-msg"
          aria-label={`Message the wallets with orders at ${formatPrice(l.price, decimals)}`}
          title="Message the wallets with orders at this price"
          onClick={(e) => {
            // The row covers a tick-wide band: asks round up into it, bids round down.
            const lo = side === 'ask' ? l.price - tick * 0.999999 : l.price;
            const hi = side === 'ask' ? l.price : l.price + tick * 0.999999;
            setTraders({ rect: e.currentTarget.parentElement.getBoundingClientRect(), side, price: l.price, lo, hi });
          }}
        >
          <ChatIcon />
        </button>
      )}
    </div>
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
      {traders && <TradersCard key={`${traders.side}${traders.price}`} {...traders} market={market} decimals={decimals} onClose={() => setTraders(null)} />}
      {/* Always rendered (fixed height) so the book doesn't jump when the sources arrive. */}
      <div className="ob-foot muted">
        {!book ? '\u00a0' : hasArcher
          ? <><Tooltip text={VENUE_INFO.archer} underline={false}><span className="venue-badge archer">A</span></Tooltip> = <Venue id="archer">Archer</Venue> order, other orders sit on <Venue id="manifest">Manifest</Venue></>
          : sourceCount > 1 ? <>Aggregated from {sourceCount} <Venue id="manifest">Manifest</Venue> markets for this pair</> : <>Source: <Venue id="manifest">Manifest</Venue></>}
      </div>
    </>
  );
}

const ChatIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </svg>
);

const shortWallet = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** A DM to `wallet` in W2W Chat, with a message about their order written for the sender to edit. */
function w2wLink(wallet, { side, size, price, market, decimals }) {
  const text = `Hi! I saw your order on SpotTerminal, ${side === 'ask' ? 'selling' : 'buying'} ${formatAmount(size)} ${market.base.symbol} at ${formatPrice(price, decimals)} ${market.quote.symbol}: https://${SITE}/trade/${market.address}`;
  return `https://w2w.chat/?dm=${encodeURIComponent(wallet)}&text=${encodeURIComponent(text)}`;
}

/** The wallets behind one order-book row, each with a W2W Chat message link. */
function TradersCard({ rect, side, price, lo, hi, market, decimals, onClose }) {
  const ref = useRef(null);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    getJSON(`/api/markets/${market.address}/orders-at?side=${side}&lo=${lo}&hi=${hi}`)
      .then(r => live && setOrders(r.orders))
      .catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [market.address, side, lo, hi]);

  // Closes on a click elsewhere, Escape, or scrolling (it is positioned next to the row).
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // Beside the book, level with the row, so the row stays visible; over it on narrow screens.
  const top = Math.max(8, Math.min(rect.top - 10, window.innerHeight - 260));
  const left = rect.right + 264 <= window.innerWidth ? rect.right + 6 : Math.max(8, rect.left + 14);
  return (
    <div ref={ref} className="ob-traders" role="dialog" aria-label="Orders at this price" style={{ top, left }}>
      <div className="ob-traders-title">
        {side === 'ask' ? 'Selling' : 'Buying'} at {formatPrice(price, decimals)} {market.quote.symbol}
      </div>
      {error ? <div className="ob-traders-note">{error}</div>
        : !orders ? <div className="ob-traders-note"><span className="spinner" /></div>
          : !orders.length ? <div className="ob-traders-note">No individual orders here (Archer quotes don&apos;t show wallets).</div>
            : (
              <ul>
                {orders.map(o => (
                  <li key={`${o.market}${o.trader}${o.price}`}>
                    <span className="mono">{shortWallet(o.trader)}</span>
                    <span className="num muted">{formatAmount(o.size)} {market.base.symbol}</span>
                    {o.trader === me
                      ? <span className="muted">you</span>
                      : <a href={w2wLink(o.trader, { side, size: o.size, price: o.price, market, decimals })} target="_blank" rel="noopener noreferrer">Message</a>}
                  </li>
                ))}
              </ul>
            )}
      <div className="ob-traders-note">Opens W2W Chat with a message written for you to edit before sending.</div>
    </div>
  );
}

function Venue({ id, children }) {
  return <Tooltip text={VENUE_INFO[id]}>{children}</Tooltip>;
}
