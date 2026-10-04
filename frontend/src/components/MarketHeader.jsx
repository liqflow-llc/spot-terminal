import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TokenIcon from './TokenIcon.jsx';
import { getJSON } from '../services/api';
import { formatPct, formatPrice, formatUsd, formatAmount } from '../utils/format';
import './MarketHeader.css';

function MarketSelector({ market }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null);
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      getJSON(`/api/markets?limit=150${query ? `&q=${encodeURIComponent(query)}` : ''}`)
        .then(r => setList(r.markets))
        .catch(() => setList([]));
    }, query ? 150 : 0);
    return () => clearTimeout(t);
  }, [open, query]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="selector" ref={ref}>
      <button type="button" className="selector-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {market ? (
          <>
            <span className="pair-icons"><TokenIcon token={market.base} size={24} /><TokenIcon token={market.quote} size={18} /></span>
            <span className="pair-name">{market.base.symbol}<span className="muted">/{market.quote.symbol}</span></span>
          </>
        ) : <span className="spinner" />}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="selector-panel">
          <input
            autoFocus
            className="selector-search"
            placeholder="Search pair or paste mint"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className="selector-head"><span>Pair</span><span>Last</span><span>24h vol</span></div>
          <div className="selector-list">
            {!list && <div className="selector-empty"><span className="spinner" /></div>}
            {list && !list.length && <div className="selector-empty">No markets match.</div>}
            {list?.map(m => (
              <button
                type="button"
                key={m.address}
                className={`selector-row ${m.address === market?.address ? 'current' : ''}`}
                onClick={() => { setOpen(false); setQuery(''); navigate(`/trade/${m.address}`); }}
              >
                <span className="selector-pair">
                  <TokenIcon token={m.base} size={18} />
                  <span>{m.base.symbol}<span className="muted">/{m.quote.symbol}</span></span>
                  {m.base.verified && m.quote.verified && <span className="verified" title="Both tokens verified by Jupiter">✓</span>}
                </span>
                <span className="num">{formatPrice(m.last)}</span>
                <span className="num muted">{m.volume24hUsd != null ? formatUsd(m.volume24hUsd) : '—'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MarketHeader({ market }) {
  const prev = useRef(null);
  const [tick, setTick] = useState('');
  useEffect(() => {
    if (market?.last && prev.current) setTick(market.last > prev.current ? 'up' : market.last < prev.current ? 'down' : tick);
    prev.current = market?.last ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market?.last]);

  const change = market?.change24h;
  return (
    <div className="market-header">
      <MarketSelector market={market} />
      {market && (
        <div className="stats">
          <div className={`stat-last num ${tick}`}>
            {formatPrice(market.last)}
            {market.quote.usdPrice && market.last ? <span className="stat-usd">≈ {formatUsd(market.last * market.quote.usdPrice)}</span> : null}
          </div>
          <Stat label="24h change" value={formatPct(change)} className={change > 0 ? 'up' : change < 0 ? 'down' : ''} />
          <Stat label="24h high" value={formatPrice(market.high24h)} />
          <Stat label="24h low" value={formatPrice(market.low24h)} />
          <Stat
            label={`24h volume (${market.quote.symbol})`}
            value={market.volume24hQuote != null ? formatAmount(market.volume24hQuote) : '—'}
            title={market.volumeWindowHours != null && market.volumeWindowHours < 24 ? `Measured over the last ${market.volumeWindowHours}h so far` : undefined}
          />
          <Stat label="Venue" value="Manifest" title="Zero-fee on-chain order book; Jupiter routes swaps through it" />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, className = '', title }) {
  return (
    <div className="stat" title={title}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value num ${className}`}>{value}</span>
    </div>
  );
}
