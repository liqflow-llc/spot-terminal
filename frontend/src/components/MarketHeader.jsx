import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import TokenIcon from './TokenIcon.jsx';
import CreateMarketModal from './CreateMarketModal.jsx';
import { getJSON } from '../services/api';
import { useFavorites } from '../hooks/useFavorites';
import { pairAddress } from '../hooks/useMarketStream';
import { formatPct, formatPrice, formatUsd, formatAmount, shortAddress } from '../utils/format';
import './MarketHeader.css';
import { VENUE_INFO } from '../venues';
import Tooltip from './Tooltip.jsx';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const SORTS = {
  pair: (a, b) => a.symbol.localeCompare(b.symbol),
  last: (a, b) => (a.last ?? -Infinity) - (b.last ?? -Infinity),
  mcap: (a, b) => (a.base.mcap ?? -Infinity) - (b.base.mcap ?? -Infinity),
  vol: (a, b) => (a.volume24hUsd ?? -Infinity) - (b.volume24hUsd ?? -Infinity),
};

/** Clicking a column sorts by it; clicking again flips the direction. Missing values stay last. */
function sortMarkets(list, sort) {
  if (!list || !sort) return list;
  const cmp = SORTS[sort.key];
  const has = (m) => (sort.key === 'pair' ? true : sort.key === 'last' ? m.last != null : sort.key === 'mcap' ? m.base.mcap != null : m.volume24hUsd != null);
  return [...list].sort((a, b) => (Number(has(b)) - Number(has(a))) || (sort.dir === 'asc' ? cmp(a, b) : cmp(b, a)));
}

function SortHead({ id, label, sort, setSort }) {
  const active = sort?.key === id;
  const next = () => setSort(active
    ? { key: id, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key: id, dir: id === 'pair' ? 'asc' : 'desc' });
  return (
    <button type="button" className={`selector-sort ${active ? 'active' : ''}`} onClick={next} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );
}

function Star({ on, onClick, size = 14 }) {
  return (
    <button
      type="button"
      className={`star ${on ? 'on' : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-pressed={on}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      style={{ fontSize: size }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

// Token markets by default (stablecoin, stock and liquid-staking pairs would fill the top of the
// list), optionally by quote; stables, stocks and LSTs have their own chips.
const QUOTE_FILTERS = [
  { id: 'all', label: 'All', mint: null, category: 'token', title: 'Token markets (stablecoins, stocks and LSTs have their own tabs)' },
  { id: 'SOL', label: 'SOL', mint: 'So11111111111111111111111111111111111111112', category: 'token', title: 'Token markets priced in SOL' },
  { id: 'USDC', label: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', category: 'token', title: 'Token markets priced in USDC' },
  { id: 'stable', label: 'Stables', mint: null, category: 'stable', title: 'Stablecoin and pegged pairs (USDT/USDC, cbBTC/WBTC, ...)' },
  { id: 'stock', label: 'Stocks', mint: null, category: 'stock', title: 'Tokenized stocks (xStocks, Ondo, PreStocks, ...)' },
  { id: 'lst', label: 'LSTs', mint: null, category: 'lst', title: 'Liquid staking tokens (JitoSOL, mSOL, JupSOL, ...)' },
];
const QUOTE_FILTER_KEY = 'spot.quoteFilter';
const readQuoteFilter = () => {
  try {
    return QUOTE_FILTERS.find(f => f.id === localStorage.getItem(QUOTE_FILTER_KEY)) || QUOTE_FILTERS[0];
  } catch {
    return QUOTE_FILTERS[0];
  }
};

function MarketSelector({ market }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null);
  const [favList, setFavList] = useState([]);
  const [heldList, setHeldList] = useState([]); // pairs of tokens the connected wallet holds
  const { favorites, isFavorite, toggle } = useFavorites();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() || null;
  const [sort, setSort] = useState(null);
  const [quoteFilter, setQuoteFilterState] = useState(readQuoteFilter);
  const [token, setToken] = useState(null);       // pasted mint: { token, quotes: [{ symbol, mint, market }] }
  const [found, setFound] = useState([]);         // tokens matching a typed name/symbol
  const [create, setCreate] = useState(null);     // { base, quote, other, mode } for the create-market / trade dialog
  const navigate = useNavigate();
  const ref = useRef(null);

  const setQuoteFilter = (f) => {
    setQuoteFilterState(f);
    try { localStorage.setItem(QUOTE_FILTER_KEY, f.id); } catch { /* storage unavailable */ }
  };

  useEffect(() => {
    if (!open) return undefined;
    const params = new URLSearchParams({ limit: '150' });
    if (query) params.set('q', query.trim());
    if (quoteFilter.mint) params.set('quote', quoteFilter.mint);
    if (quoteFilter.category) params.set('category', quoteFilter.category);
    const t = setTimeout(() => {
      getJSON(`/api/markets?${params}`)
        .then(r => setList(r.markets))
        .catch(() => setList([]));
    }, query ? 150 : 0);
    return () => clearTimeout(t);
  }, [open, query, quoteFilter]);

  // Favourites may be outside the top-150 list, so fetch them by address.
  const favKey = favorites.join(',');
  useEffect(() => {
    if (!open || !favKey) return setFavList([]);
    let live = true;
    getJSON(`/api/markets?addresses=${favKey}`).then(r => live && setFavList(r.markets)).catch(() => {});
    return () => { live = false; };
  }, [open, favKey]);

  // Pairs of the tokens in the connected wallet (worth $10+) go first.
  useEffect(() => {
    if (!open || !wallet) return setHeldList([]);
    let live = true;
    getJSON(`/api/wallet/holdings?wallet=${wallet}`).then(r => live && setHeldList(r.markets)).catch(() => {});
    return () => { live = false; };
  }, [open, wallet]);

  // A pasted mint can be turned into a new market if it has none yet; a typed name or symbol
  // also looks for verified tokens that have no market at all.
  useEffect(() => {
    setToken(null);
    setFound([]);
    const text = query.trim();
    if (!open || text.length < 2) return undefined;
    let live = true;
    const t = setTimeout(() => {
      if (MINT_RE.test(text)) getJSON(`/api/tokens/${text}`).then(r => live && setToken(r)).catch(() => {});
      else getJSON(`/api/tokens/search?q=${encodeURIComponent(text)}`).then(r => live && setFound(r.tokens)).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(t); };
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

  const go = (address) => { setOpen(false); setQuery(''); navigate(`/trade/${address}`); };
  const startCreate = (base = '', quote = null) => { setOpen(false); setCreate({ base, quote, mode: 'create' }); };
  // "Market buy or sell any pair": the same two-token form, opening the pair for market orders.
  const startTrade = (base = '') => { setOpen(false); setCreate({ base, quote: 'other', mode: 'trade' }); };

  // A row is a pair: its busiest market, plus the others (`pairMarkets`) trading the same pair.
  const members = (m) => m.pairMarkets || [m.address];
  const isFav = (m) => members(m).some(isFavorite);
  const toggleFav = (m) => (isFav(m) ? members(m).filter(isFavorite).forEach(toggle) : toggle(m.address));
  const samePair = (a, b) => a.base.mint === b.base.mint && a.quote.mint === b.quote.mint;
  // Pairs of tokens in the wallet first, then starred ones (those matching the search and
  // filter), then the rest; each group sorted.
  const q = query.trim().toLowerCase();
  const matches = (m) => (!quoteFilter.mint || m.quote.mint === quoteFilter.mint)
    && (!!q || !quoteFilter.category || !m.category || m.category === quoteFilter.category)
    && (!q || list.some(x => samePair(x, m)) || m.symbol.toLowerCase().includes(q));
  const heldMatches = list ? heldList.filter(matches) : [];
  const isHeld = (m) => heldMatches.some(h => samePair(h, m));
  const favMatches = [];
  for (const f of list ? favList.filter(m => isFavorite(m.address) && matches(m)) : []) {
    const row = list.find(x => members(x).includes(f.address)) || f;
    if (!isHeld(row) && !favMatches.some(x => samePair(x, row))) favMatches.push(row);
  }
  const sorted = list && [
    ...(sortMarkets(heldMatches, sort) || []),
    ...(sortMarkets(favMatches, sort) || []),
    ...(sortMarkets(list.filter(m => !isFav(m) && !isHeld(m)), sort) || []),
  ];
  // A pasted token with no Manifest market at all (against anything): offer market orders and creating one.
  // One with any market just lists its markets; "+ Create market" still makes new pairs.
  const noMarketToken = token && token.marketCount === 0 && !list?.some(m => m.base.mint === token.token.mint || m.quote.mint === token.token.mint)
    ? token : null;
  const pastedMint = MINT_RE.test(query.trim()) ? query.trim() : '';
  // Verified tokens whose name matched and that have no market at all, with or without orders.
  // (A token with only empty markets shows those markets in the list instead.)
  const noMarket = found.filter(t => (t.markets ?? t.activeMarkets) === 0 && !list?.some(m => m.base.mint === t.mint || m.quote.mint === t.mint));

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
            placeholder="Search pair, token or paste mint"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className="selector-filters" role="tablist" aria-label="Quote token">
            {QUOTE_FILTERS.map(f => (
              <button key={f.id} type="button" role="tab" aria-selected={quoteFilter.id === f.id} className={`selector-filter ${quoteFilter.id === f.id ? 'active' : ''}`} title={f.title} onClick={() => setQuoteFilter(f)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="selector-list">
            <div className="selector-head">
              <span />
              <SortHead id="pair" label="Pair" sort={sort} setSort={setSort} />
              <SortHead id="last" label="Last" sort={sort} setSort={setSort} />
              <span className="selector-mcap" title="Market cap of the token: circulating supply × price (Jupiter; verified tokens)">
                <SortHead id="mcap" label="Mcap" sort={sort} setSort={setSort} />
              </span>
              <SortHead id="vol" label="24h vol" sort={sort} setSort={setSort} />
            </div>
            {!list && <div className="selector-empty"><span className="spinner" /></div>}
            {list && !sorted.length && !noMarketToken && !noMarket.length && <div className="selector-empty">No markets match.</div>}
            {sorted?.map(m => (
              <div
                role="button"
                tabIndex={0}
                key={m.address}
                className={`selector-row ${members(m).includes(market?.address) ? 'current' : ''} ${isFav(m) ? 'fav' : ''}`}
                onClick={() => go(m.address)}
                onKeyDown={(e) => { if (e.key === 'Enter') go(m.address); }}
              >
                <Star on={isFav(m)} onClick={() => toggleFav(m)} />
                <span className="selector-pair">
                  <TokenIcon token={m.base} size={18} />
                  <span>{m.base.symbol}<span className="muted">/{m.quote.symbol}</span></span>
                  {m.base.verified && m.quote.verified && <span className="verified" title="Both tokens verified by Jupiter">✓</span>}
                  {m.orders === 0 && <span className="selector-tag" title="No orders on this market yet">empty</span>}
                  {m.marketCount > 1 && (
                    <span className="selector-tag" title={`${m.marketCount} Manifest order books trade this pair (anyone can open one). The trade page combines the busiest.`}>×{m.marketCount}</span>
                  )}
                  {m.held && (
                    <span className="selector-tag held" title={`Yours (wallet and open sell orders here): ${formatAmount(m.held.amount)} ${m.base.symbol}`}>{formatUsd(m.held.usd)} held</span>
                  )}
                </span>
                <span className="num">{formatPrice(m.last)}</span>
                <span className="num muted selector-mcap">{m.base.mcap != null ? formatUsd(m.base.mcap) : '—'}</span>
                <span className="num muted">{m.volume24hUsd == null ? '—' : m.volume24hUsd < 0.01 ? '<$0.01' : formatUsd(m.volume24hUsd)}</span>
              </div>
            ))}
            {noMarketToken && (
              <div className="selector-create">
                <div className="selector-create-title">
                  <TokenIcon token={noMarketToken.token} size={18} />
                  <span>No {noMarketToken.token.symbol} market for limit orders.</span>
                </div>
                <div className="selector-create-sub muted">Place market order:</div>
                <div className="selector-create-actions">
                  {noMarketToken.quotes.map(x => (
                    <button key={x.mint} type="button" className="btn small primary" onClick={() => go(pairAddress(noMarketToken.token.mint, x.mint))}>
                      Market trade {noMarketToken.token.symbol}/{x.symbol}
                    </button>
                  ))}
                  <button type="button" className="btn small primary" onClick={() => startTrade(noMarketToken.token.mint)}>
                    Market trade {noMarketToken.token.symbol}/other token…
                  </button>
                </div>
                <div className="selector-create-sub muted">Create market for limit orders:</div>
                <div className="selector-create-actions">
                  {noMarketToken.quotes.map(x => (
                    <button key={x.mint} type="button" className="btn small" onClick={() => startCreate(noMarketToken.token.mint, x.symbol)}>
                      Create {noMarketToken.token.symbol}/{x.symbol}
                    </button>
                  ))}
                  <button type="button" className="btn small" onClick={() => startCreate(noMarketToken.token.mint, 'other')}>
                    {noMarketToken.token.symbol}/other token…
                  </button>
                </div>
              </div>
            )}
            {noMarket.length > 0 && (
              <div className="selector-create">
                <div className="selector-create-title"><span>Tokens with no market yet</span></div>
                {noMarket.map(t => (
                  <div key={t.mint} className="selector-nomarket">
                    <TokenIcon token={t} size={18} />
                    <span className="selector-nomarket-name"><strong>{t.symbol}</strong> <span className="muted">{t.name}</span></span>
                    <button type="button" className="btn small primary" title={`Trade ${t.symbol}/SOL via Jupiter`} onClick={() => go(pairAddress(t.mint, SOL_MINT))}>Market trade</button>
                    <button type="button" className="btn small" onClick={() => startCreate(t.mint)}>Create market</button>
                  </div>
                ))}
              </div>
            )}
            {list && (
              <button type="button" className="selector-create-any" onClick={() => startCreate()}>
                ＋ Create market
              </button>
            )}
            {list && (
              <button type="button" className="selector-create-any" onClick={() => startTrade(pastedMint)}>
                Market buy or sell any pair
              </button>
            )}
          </div>
        </div>
      )}
      {create && <CreateMarketModal initialBase={create.base} initialQuote={create.quote} mode={create.mode} onClose={() => setCreate(null)} />}
    </div>
  );
}

export default function MarketHeader({ market }) {
  const { isFavorite, toggle } = useFavorites();
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
      {market && !market.noMarket && <Star on={isFavorite(market.address)} onClick={() => toggle(market.address)} size={18} />}
      {market?.noMarket && (
        <div className="stats">
          <div className="stat-last num">
            {formatPrice(market.last)}
            {market.quote.usdPrice && market.last ? <span className="stat-usd">≈ {formatUsd(market.last * market.quote.usdPrice)}</span> : null}
          </div>
          <Stat label="Venue" value="Jupiter · no order book yet" title="No Manifest market for this pair yet. Trades go through Jupiter at the best price across every Solana DEX, and the price shown is Jupiter's. Create the market to get a zero-fee order book for limit orders." />
          <TokenAddress token={market.base} />
        </div>
      )}
      {market && !market.noMarket && (
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
          <Stat label="Venue" value="Manifest" title={VENUE_INFO.manifest} />
          <TokenAddress token={market.base} market={market.address} />
        </div>
      )}
    </div>
  );
}

/** The base token's mint, copyable, with a Solscan link (and the market account in the tooltip). */
function TokenAddress({ token, market }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context or permissions): the link still works.
    }
  };
  return (
    <div className="stat token-address" title={`${token.symbol} token: ${token.mint}${market ? `\nManifest market: ${market}` : ''}`}>
      <span className="stat-label">{token.symbol} address</span>
      <span className="stat-value num">
        <a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer">{shortAddress(token.mint)}</a>
        <button type="button" className="copy-btn" onClick={copy} aria-label={`Copy ${token.symbol} token address`}>{copied ? '✓' : '⧉'}</button>
      </span>
    </div>
  );
}

function Stat({ label, value, className = '', title }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value num ${className}`}>{title ? <Tooltip text={title}>{value}</Tooltip> : value}</span>
    </div>
  );
}
