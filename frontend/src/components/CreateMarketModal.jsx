import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Modal from './Modal.jsx';
import TokenIcon from './TokenIcon.jsx';
import { useToast } from './Toasts.jsx';
import { getJSON, postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { shortAddress } from '../utils/format';
import './CreateMarketModal.css';
import { reportError } from '../services/report';
import { pairAddress } from '../hooks/useMarketStream';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OTHER = 'other';

/** Resolve a pasted mint to { token, quotes } via the backend, or an error message. */
function useToken(mint) {
  const [state, setState] = useState(null); // { mint, data } | { mint, error }
  useEffect(() => {
    const m = (mint || '').trim();
    if (!MINT_RE.test(m)) { setState(null); return undefined; }
    let live = true;
    const t = setTimeout(() => getJSON(`/api/tokens/${m}`)
      .then(data => live && setState({ mint: m, data }))
      .catch(err => live && setState({ mint: m, error: err.message })), 250);
    return () => { live = false; clearTimeout(t); };
  }, [mint]);
  return state?.mint === (mint || '').trim() ? state : null;
}

const PRESET_QUOTES = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};
/** Props that open the dialog on a given pair (SOL and USDC are chips; anything else is "Other"). */
export const createPairProps = (baseMint, quoteMint) => (PRESET_QUOTES[quoteMint]
  ? { initialBase: baseMint, initialQuote: PRESET_QUOTES[quoteMint] }
  : { initialBase: baseMint, initialQuote: 'other', initialOther: quoteMint });

/**
 * Create a Manifest market for any token against SOL, USDC or any other token (by its mint).
 * Opened with both tokens chosen (e.g. "Create SKIRM/SOL"), it goes straight to the cost step.
 * mode="trade": the same two-token form opens the pair for market orders (through Jupiter),
 * whether or not it has a Manifest market.
 */
export default function CreateMarketModal({ initialBase = '', initialQuote = null, initialOther = '', mode = 'create', onClose }) {
  const trading = mode === 'trade';
  const { publicKey, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const navigate = useNavigate();
  const [baseInput, setBaseInput] = useState(initialBase);
  const [quoteChoice, setQuoteChoice] = useState(initialQuote || 'SOL'); // a symbol from the list, or OTHER
  const [otherInput, setOtherInput] = useState(initialOther);
  const [stage, setStage] = useState({ step: 'form' }); // form | preparing | confirm | signing
  const [error, setError] = useState(null);
  const base = useToken(baseInput);
  const other = useToken(quoteChoice === OTHER ? otherInput : '');

  const quotes = base?.data?.quotes || [];
  const presetQuote = quotes.find(q => q.symbol === quoteChoice) || null;
  const quote = quoteChoice === OTHER
    ? (other?.data ? { symbol: other.data.token.symbol, mint: other.data.token.mint, market: null, token: other.data.token } : null)
    : presetQuote;
  const sameToken = base?.data && quote && base.data.token.mint === quote.mint;
  const ready = !!base?.data && !!quote && !sameToken;

  const go = (address) => { onClose(); navigate(`/trade/${address}`); };
  // A pair without a Manifest market opens as "<base>-<quote>" (Jupiter only); one with a market opens it.
  const trade = () => go(presetQuote?.market || pairAddress(base.data.token.mint, quote.mint));

  async function prepare() {
    if (!publicKey) { setVisible(true); return; }
    setError(null);
    setStage({ step: 'preparing' });
    try {
      const prepared = await postJSON('/api/markets/create', { wallet: publicKey.toBase58(), baseMint: base.data.token.mint, quoteMint: quote.mint });
      if (prepared.step === 'exists') return go(prepared.market);
      setStage({ step: 'confirm', prepared });
    } catch (err) {
      setError(err.message);
      setStage({ step: 'form' });
    }
  }

  async function create() {
    const { prepared } = stage;
    setStage({ step: 'signing', prepared });
    try {
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({ kind: 'success', title: `${base.data.token.symbol}/${quote.symbol} market created`, message: 'Place the first order to start the book.', link: explorerTx(res.signature) });
      go(res.market);
    } catch (err) {
      if (!isUserRejection(err)) {
        setError(err.message);
        reportError('create_market_failed', err, { wallet: publicKey?.toBase58() });
      }
      setStage({ step: 'confirm', prepared });
    }
  }

  // Opened with both sides chosen: skip straight to the cost once the base token resolves.
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (trading || autoStarted || !initialBase || !initialQuote || (initialQuote === OTHER && !initialOther) || !ready || !publicKey) return;
    setAutoStarted(true);
    if (presetQuote?.market) go(presetQuote.market); else prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, publicKey]);

  const pair = ready ? `${base.data.token.symbol}/${quote.symbol}` : null;
  const busy = stage.step === 'preparing' || stage.step === 'signing';

  return (
    <Modal
      title={trading ? 'Market buy or sell any pair' : pair && stage.step !== 'form' ? `Create ${pair} market` : 'Create a market'}
      onClose={() => !busy && onClose()}
      actions={(
        <>
          {stage.step === 'confirm' || stage.step === 'signing'
            ? <button type="button" className="btn" disabled={busy} onClick={() => setStage({ step: 'form' })}>Back</button>
            : <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>}
          {trading ? (
            <button type="button" className="btn primary" disabled={!ready} onClick={trade}>{pair ? `Trade ${pair}` : 'Trade'}</button>
          ) : stage.step === 'form' || stage.step === 'preparing' ? (
            presetQuote?.market && quoteChoice !== OTHER
              ? <button type="button" className="btn primary" onClick={() => go(presetQuote.market)}>Open {pair} market</button>
              : <button type="button" className="btn primary" disabled={!ready || busy} onClick={prepare}>{stage.step === 'preparing' ? 'Preparing…' : publicKey ? 'Continue' : 'Connect wallet'}</button>
          ) : (
            <button type="button" className="btn primary" disabled={busy} onClick={create}>{stage.step === 'signing' ? 'Approve in your wallet…' : 'Create market'}</button>
          )}
        </>
      )}
    >
      {stage.step === 'confirm' || stage.step === 'signing' ? (
        <p>
          Opens a new zero-fee {pair} order book on Manifest that anyone can trade. One-time cost of{' '}
          <strong>{stage.prepared.summary.costSol.toFixed(4)} SOL</strong> (network rent, not refundable).
        </p>
      ) : (
        <div className="cm-form">
          <label className="cm-label" htmlFor="cm-base">{trading ? 'Token to buy or sell' : 'Token to trade (base)'}</label>
          <input id="cm-base" className="cm-input" placeholder="Paste the token's mint address" value={baseInput} onChange={e => setBaseInput(e.target.value.trim())} autoFocus={!initialBase} />
          <TokenLine state={base} input={baseInput} />

          <span className="cm-label">{trading ? 'Paid in (any token)' : 'Priced in (quote)'}</span>
          <div className="cm-quotes">
            {(quotes.length ? quotes : [{ symbol: 'SOL' }, { symbol: 'USDC' }]).map(q => (
              <button key={q.symbol} type="button" className={`cm-chip ${quoteChoice === q.symbol ? 'active' : ''}`} onClick={() => setQuoteChoice(q.symbol)}>
                {q.symbol}{q.market && !trading ? <span className="cm-exists"> · exists</span> : null}
              </button>
            ))}
            <button type="button" className={`cm-chip ${quoteChoice === OTHER ? 'active' : ''}`} onClick={() => setQuoteChoice(OTHER)}>Other token…</button>
          </div>
          {quoteChoice === OTHER && (
            <>
              <input className="cm-input" placeholder="Paste the quote token's mint address" value={otherInput} onChange={e => setOtherInput(e.target.value.trim())} autoFocus />
              <TokenLine state={other} input={otherInput} />
            </>
          )}
          {sameToken && <p className="cm-error">Pick two different tokens.</p>}
          {!trading && presetQuote?.market && quoteChoice !== OTHER && <p className="cm-note">This market already exists, so there&apos;s nothing to create.</p>}
          {trading && <p className="cm-note">Fills right away at the best price across every Solana DEX, through Jupiter.</p>}
          {error && <p className="cm-error">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function TokenLine({ state, input }) {
  if (!input) return null;
  if (!MINT_RE.test(input)) return <p className="cm-note">That doesn&apos;t look like a mint address.</p>;
  if (!state) return <p className="cm-note"><span className="spinner" /> Looking up…</p>;
  if (state.error) return <p className="cm-error">{state.error}</p>;
  const t = state.data.token;
  return (
    <p className="cm-token">
      <TokenIcon token={t} size={18} />
      <strong>{t.symbol}</strong> <span className="muted">{t.name}</span>
      {t.verified ? <span className="verified" title="On Jupiter's verified list">✓</span> : <span className="cm-unverified" title="Not on Jupiter's verified list: double-check the address">unverified</span>}
      <span className="muted num">{shortAddress(t.mint)}</span>
    </p>
  );
}
