import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TokenIcon from './TokenIcon.jsx';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Modal from './Modal.jsx';
import { useToast } from './Toasts.jsx';
import { getJSON, postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { formatPct, formatPrice, formatUsd, formatAmount } from '../utils/format';
import './MarketHeader.css';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SORTS = {
  pair: (a, b) => a.symbol.localeCompare(b.symbol),
  last: (a, b) => (a.last ?? -Infinity) - (b.last ?? -Infinity),
  vol: (a, b) => (a.volume24hUsd ?? -Infinity) - (b.volume24hUsd ?? -Infinity),
};

/** Clicking a column sorts by it; clicking again flips the direction. Missing values stay last. */
function sortMarkets(list, sort) {
  if (!list || !sort) return list;
  const cmp = SORTS[sort.key];
  const has = (m) => (sort.key === 'pair' ? true : (sort.key === 'last' ? m.last != null : m.volume24hUsd != null));
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

function MarketSelector({ market }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null);
  const [sort, setSort] = useState(null);
  const [token, setToken] = useState(null); // pasted mint: { token, quotes: [{ symbol, mint, market }] }
  const [create, setCreate] = useState(null); // { base, quote, prepared, busy }
  const { publicKey, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
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

  // A pasted mint can be turned into a new market if it has none yet.
  useEffect(() => {
    setToken(null);
    const mint = query.trim();
    if (!open || !MINT_RE.test(mint)) return undefined;
    let live = true;
    const t = setTimeout(() => getJSON(`/api/tokens/${mint}`).then(r => live && setToken(r)).catch(() => {}), 250);
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

  async function startCreate(quote) {
    if (!publicKey) return setVisible(true);
    const base = token.token;
    setOpen(false);
    setCreate({ base, quote, prepared: null, busy: 'Preparing…' });
    try {
      const prepared = await postJSON('/api/markets/create', { wallet: publicKey.toBase58(), baseMint: base.mint, quoteMint: quote.mint });
      if (prepared.step === 'exists') { setCreate(null); return go(prepared.market); }
      setCreate({ base, quote, prepared, busy: null });
    } catch (err) {
      setCreate(null);
      toast({ kind: 'error', title: 'Could not create market', message: err.message });
    }
  }

  async function confirmCreate() {
    const { prepared, base, quote } = create;
    setCreate(c => ({ ...c, busy: 'Approve in your wallet…' }));
    try {
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({ kind: 'success', title: `${base.symbol}/${quote.symbol} market created`, message: 'Place the first order to start the book.', link: explorerTx(res.signature) });
      setCreate(null);
      go(res.market);
    } catch (err) {
      setCreate(null);
      if (!isUserRejection(err)) toast({ kind: 'error', title: 'Could not create market', message: err.message });
    }
  }

  const sorted = sortMarkets(list, sort);
  const creatable = token?.quotes.filter(q => !q.market && !list?.some(m => m.base.mint === token.token.mint && m.quote.mint === q.mint)) || [];

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
          <div className="selector-head">
            <SortHead id="pair" label="Pair" sort={sort} setSort={setSort} />
            <SortHead id="last" label="Last" sort={sort} setSort={setSort} />
            <SortHead id="vol" label="24h vol" sort={sort} setSort={setSort} />
          </div>
          <div className="selector-list">
            {!list && <div className="selector-empty"><span className="spinner" /></div>}
            {list && !list.length && !creatable.length && <div className="selector-empty">No markets match.</div>}
            {sorted?.map(m => (
              <button
                type="button"
                key={m.address}
                className={`selector-row ${m.address === market?.address ? 'current' : ''}`}
                onClick={() => go(m.address)}
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
            {creatable.length > 0 && (
              <div className="selector-create">
                <div className="selector-create-title">
                  <TokenIcon token={token.token} size={18} />
                  <span>No {token.token.symbol}/{creatable.map(q => q.symbol).join(' or ')} market yet</span>
                </div>
                <div className="selector-create-actions">
                  {creatable.map(q => (
                    <button key={q.mint} type="button" className="btn small" onClick={() => startCreate(q)}>
                      Create {token.token.symbol}/{q.symbol}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {create && (
        <Modal
          title={`Create ${create.base.symbol}/${create.quote.symbol} market`}
          onClose={() => !create.busy?.startsWith('Approve') && setCreate(null)}
          actions={(
            <>
              <button type="button" className="btn" disabled={!!create.busy} onClick={() => setCreate(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={!!create.busy} onClick={confirmCreate}>{create.busy || 'Create market'}</button>
            </>
          )}
        >
          {create.prepared ? (
            <p>
              Opens a new zero-fee order book on Manifest that anyone can trade. One-time cost of{' '}
              <strong>{create.prepared.summary.costSol.toFixed(4)} SOL</strong> (network rent, not refundable).
            </p>
          ) : <p><span className="spinner" /> Preparing…</p>}
        </Modal>
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
