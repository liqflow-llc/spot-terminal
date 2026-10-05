import { useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Modal from './Modal.jsx';
import { useToast } from './Toasts.jsx';
import { postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { formatAmount, formatPrice, toInputString } from '../utils/format';

const SOL = 'So11111111111111111111111111111111111111112';
const SOL_RESERVE = 0.02;
const PERCENTS = [25, 50, 75, 100];
const SLIPPAGES = [10, 50, 100, 200]; // bps
const WARN_DEVIATION = 0.05; // matches PRICE_WARN_DEVIATION on the backend
const QUOTE_DEBOUNCE_MS = 500;
const QUOTE_REFRESH_MS = 10_000;

const VENUE_NAMES = { 'Manifest': 'Manifest', 'Archer': 'Archer' };

/**
 * Market orders: filled right away at the best price across every Solana venue (Manifest,
 * Archer, AMMs), routed by Jupiter. Buys are entered as an amount to spend, sells as an amount
 * to sell; the slippage limit caps the worst price.
 */
export default function MarketOrder({ market, side, account, onPlaced }) {
  const { publicKey, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState(null); // { key, summary } | { key, error }
  const [busy, setBusy] = useState(null);
  const [riskPrompt, setRiskPrompt] = useState(null);
  const base = market.base, quoteToken = market.quote;
  const isBuy = side === 'buy';
  const inToken = isBuy ? quoteToken : base, outToken = isBuy ? base : quoteToken;

  useEffect(() => setAmount(''), [market.address, side]);

  // Only wallet balances count: a swap can't spend funds sitting in a Manifest market.
  const available = useMemo(() => {
    if (!account?.wallet) return null;
    let bal = isBuy ? account.wallet.quote : account.wallet.base;
    if (inToken.mint === SOL) bal = Math.max(0, bal - SOL_RESERVE);
    return bal;
  }, [account, isBuy, inToken.mint]);

  const a = Number(amount);
  const key = `${market.address}|${side}|${amount}|${slippageBps}`;

  // Live quote while typing (debounced) and every few seconds after.
  useEffect(() => {
    if (!(a > 0)) { setQuote(null); return undefined; }
    let live = true;
    const load = () => postJSON('/api/swap/quote', { market: market.address, side, amount, slippageBps })
      .then(summary => live && setQuote({ key, summary }))
      .catch(err => live && setQuote({ key, error: err.message }));
    const first = setTimeout(load, QUOTE_DEBOUNCE_MS);
    const t = setInterval(load, QUOTE_REFRESH_MS);
    return () => { live = false; clearTimeout(first); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const q = quote?.key === key ? quote.summary : null;
  const quoteError = quote?.key === key ? quote.error : null;
  const worst = q ? Math.max(q.deviation ?? -1, q.priceImpact) : null;
  const risky = worst != null && worst > WARN_DEVIATION;
  const insufficient = available != null && a > available + 1e-12;

  const setPercent = (pct) => available && setAmount(toInputString((available * pct) / 100, inToken.decimals));

  const confirmRisk = (detail) => new Promise(resolve => setRiskPrompt({ resolve, detail })).finally(() => setRiskPrompt(null));

  async function submit() {
    if (!publicKey) return setVisible(true);
    if (!(a > 0)) return toast({ kind: 'error', title: 'Enter an amount' });
    try {
      let ack = false;
      if (risky) {
        if (!await confirmRisk(null)) return;
        ack = true;
      }
      setBusy('Getting best price…');
      const body = { wallet: publicKey.toBase58(), market: market.address, side, amount, slippageBps, acknowledgePriceRisk: ack };
      let prepared;
      try {
        prepared = await postJSON('/api/swap/prepare', body);
      } catch (err) {
        if (err.code !== 'PRICE_DEVIATION') throw err;
        setBusy(null);
        if (!await confirmRisk(err.message)) return;
        setBusy('Getting best price…');
        prepared = await postJSON('/api/swap/prepare', { ...body, acknowledgePriceRisk: true });
      }
      setBusy('Approve in your wallet…');
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({
        kind: 'success',
        title: isBuy ? `Bought ${base.symbol}` : `Sold ${base.symbol}`,
        message: `${formatAmount(res.inAmount)} ${inToken.symbol} → about ${formatAmount(res.outAmount)} ${outToken.symbol} (avg ${formatPrice(res.price)} ${quoteToken.symbol}).`,
        link: explorerTx(res.signature),
      });
      setAmount('');
      onPlaced?.();
    } catch (err) {
      if (isUserRejection(err)) toast({ title: 'Cancelled in wallet' });
      else toast({ kind: 'error', title: 'Trade failed', message: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="of-avail">
        <span className="muted">Available</span>
        <span className="num">{available == null ? '—' : `${formatAmount(available)} ${inToken.symbol}`}</span>
      </div>

      <label className="of-field">
        <span className="of-field-label">{isBuy ? 'Spend' : 'Amount'}</span>
        <input inputMode="decimal" value={amount} placeholder="0" onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
        <span className="of-field-unit">{inToken.symbol}</span>
      </label>
      <div className="of-percents">
        {PERCENTS.map(pct => (
          <button key={pct} type="button" className="of-pct" onClick={() => setPercent(pct)} disabled={!available}>{pct}%</button>
        ))}
      </div>

      <div className="of-slippage">
        <span className="muted" title="The most the price may move against you before the trade is cancelled">Max slippage</span>
        <div className="of-slippage-options">
          {SLIPPAGES.map(bps => (
            <button key={bps} type="button" className={`of-pct ${slippageBps === bps ? 'active' : ''}`} onClick={() => setSlippageBps(bps)}>{bps / 100}%</button>
          ))}
        </div>
      </div>

      {quoteError && <div className="of-note warn">{quoteError}</div>}
      {risky && (
        <div className="of-note danger" role="alert">
          <strong>⚠ Up to {(worst * 100).toFixed(1)}% worse than the market price.</strong>{' '}
          {q.priceImpact > WARN_DEVIATION ? 'This order is large for the available liquidity.' : 'Check the amount and slippage.'}
        </div>
      )}

      <button
        type="button"
        className={`of-submit ${side}`}
        onClick={submit}
        disabled={!!busy || (publicKey && (insufficient || !(a > 0) || !q))}
      >
        {busy || (!publicKey ? 'Connect wallet' : insufficient ? 'Insufficient balance' : `${isBuy ? 'Buy' : 'Sell'} ${base.symbol} now`)}
      </button>

      <dl className="of-summary">
        <div><dt>You receive (est.)</dt><dd className="num">{q ? `${formatAmount(q.outAmount)} ${outToken.symbol}` : '—'}</dd></div>
        <div><dt>At least</dt><dd className="num">{q ? `${formatAmount(q.minOut)} ${outToken.symbol}` : '—'}</dd></div>
        <div><dt>Avg price</dt><dd className="num">{q?.price ? `${formatPrice(q.price)} ${quoteToken.symbol}` : '—'}</dd></div>
        <div><dt>Price impact</dt><dd className={`num ${q && q.priceImpact > 0.01 ? 'warn-text' : ''}`}>{q ? `${(q.priceImpact * 100).toFixed(2)}%` : '—'}</dd></div>
        <div><dt>Route</dt><dd>{q?.venues?.length ? q.venues.map(v => VENUE_NAMES[v] || v).join(' + ') : '—'} <span className="muted">via Jupiter</span></dd></div>
        <div><dt>Payout</dt><dd>Straight to your wallet</dd></div>
      </dl>

      {riskPrompt && (
        <Modal
          title="Price far from market"
          danger
          onClose={() => riskPrompt.resolve(false)}
          actions={(
            <>
              <button type="button" className="btn primary" onClick={() => riskPrompt.resolve(false)}>Go back</button>
              <button type="button" className="btn danger" onClick={() => riskPrompt.resolve(true)}>Trade anyway</button>
            </>
          )}
        >
          {riskPrompt.detail ? <p>{riskPrompt.detail}</p> : (
            <p>
              This market {side} could fill up to <strong className="danger-text">{(worst * 100).toFixed(1)}% worse</strong> than
              the market price{q?.reference ? <> of {formatPrice(q.reference)} {quoteToken.symbol}</> : null}
              {q?.worstPrice ? <> (worst allowed price {formatPrice(q.worstPrice)} {quoteToken.symbol})</> : null}.
            </p>
          )}
          <p>Market orders fill immediately and can&rsquo;t be undone. A limit order lets you choose your price instead.</p>
        </Modal>
      )}
    </>
  );
}
